// Package dns implements the DNS-TXT verification half of the directory
// server-submission flow. The directory issues a one-time token on
// POST /servers; the operator drops that token into a TXT record at
// `_boson.<hostname>`; the service.Verify() method calls this package to
// confirm the record is published across multiple independent resolvers.
//
// We query three public resolvers in parallel — Cloudflare 1.1.1.1,
// Google 8.8.8.8, and Quad9 9.9.9.9 — over TCP so EDNS-stripping
// middleboxes don't truncate the answer. Each resolver has a 5-second
// budget; the whole batch is bounded by the caller's context. The match
// condition is intentionally lenient on RDATA encoding (single string or
// multi-string concatenation, surrounding quotes vs. raw) but strict on
// the token text — we look for the literal substring
// `boson-verify=<token>` in any TXT record returned for the queried name.
package dns

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	miekg "github.com/miekg/dns"
)

// Resolver identifies one of the public resolvers we query. The value is
// the host:port we pass to miekg/dns; the key (Provider) is what we surface
// to clients in the per-resolver result map so they can render a clear
// status without needing to know IPs.
type Resolver struct {
	Provider string // "cloudflare", "google", "quad9"
	Addr     string // "1.1.1.1:53" etc.
}

// DefaultResolvers is the production resolver triple. Order doesn't matter
// because queries run in parallel — the slice is kept stable so the
// per-resolver result map is iterated deterministically in tests.
var DefaultResolvers = []Resolver{
	{Provider: "cloudflare", Addr: "1.1.1.1:53"},
	{Provider: "google", Addr: "8.8.8.8:53"},
	{Provider: "quad9", Addr: "9.9.9.9:53"},
}

// Outcome enumerates the per-resolver verdicts surfaced to the HTTP layer.
type Outcome string

const (
	OutcomeMatch         Outcome = "match"          // expected token found in some TXT record
	OutcomeMissingRecord Outcome = "missing_record" // no TXT records at all, or none containing the token
	OutcomeTimeout       Outcome = "timeout"        // per-resolver budget exceeded
	OutcomeError         Outcome = "error"          // network / refused / parse failure
)

// Result is the per-resolver verdict plus an optional human-readable
// detail message (the actual TXT values seen, or the underlying error
// string). Always non-nil even when Outcome == match.
type Result struct {
	Outcome Outcome  `json:"outcome"`
	Detail  string   `json:"detail,omitempty"`
	Records []string `json:"records,omitempty"`
}

// Mode controls how many resolver matches are required to call the overall
// verification a success. Initial verifications (Mode=Strict) require all
// three resolvers to match; periodic re-verifications (Mode=Lenient)
// require any two of three so a single resolver hiccup doesn't lapse a
// healthy listing.
type Mode int

const (
	ModeStrict  Mode = iota // 3 of 3 must match
	ModeLenient             // 2 of 3 must match
)

// Report is the aggregated answer the service layer feeds back to the
// HTTP handler. Success carries the conclusion ("verified"); Results gives
// the caller enough detail to render a per-resolver status matrix in the UI.
type Report struct {
	Success bool                `json:"success"`
	Mode    Mode                `json:"-"`
	Token   string              `json:"-"` // the literal value we searched for
	Results map[string]Result   `json:"results"` // keyed by Resolver.Provider
}

// Verifier checks a TXT-record claim. The interface exists so the service
// + HTTP layer can swap in a fake for unit tests without spinning up a
// real DNS server.
type Verifier interface {
	Verify(ctx context.Context, hostname, token string, mode Mode) (Report, error)
}

// AlwaysSucceedVerifier is the dev-mode short-circuit. It returns a
// "matched on all configured resolvers" Report for every call so the
// caller never has to issue a real DNS query. Wired in by the backend
// when SKIP_DNS_VERIFY=true — useful when registering a server against
// a hostname you don't actually own (e.g. localhost / a LAN address
// during dev). Never used in production.
type AlwaysSucceedVerifier struct{}

func (AlwaysSucceedVerifier) Verify(_ context.Context, _, _ string, _ Mode) (Report, error) {
	return Report{
		Success: true,
		Results: map[string]Result{
			"cloudflare": {Outcome: OutcomeMatch, Detail: "dev-mode bypass"},
			"google":     {Outcome: OutcomeMatch, Detail: "dev-mode bypass"},
			"quad9":      {Outcome: OutcomeMatch, Detail: "dev-mode bypass"},
		},
	}, nil
}

// NewVerifier returns the production verifier wired to DefaultResolvers
// with a 5-second per-resolver timeout. Pass an alternate resolvers list
// or timeout via the With… options when constructing a test-specific
// verifier — the production wiring stays a single-line call site.
func NewVerifier(opts ...Option) Verifier {
	v := &verifier{
		resolvers:      DefaultResolvers,
		perResolverTTL: 5 * time.Second,
	}
	for _, opt := range opts {
		opt(v)
	}
	return v
}

type Option func(*verifier)

// WithResolvers overrides the resolver set. Used by tests to point at a
// stub miekg server bound to 127.0.0.1:<chosen port>.
func WithResolvers(resolvers []Resolver) Option {
	return func(v *verifier) { v.resolvers = resolvers }
}

// WithPerResolverTimeout overrides the per-query budget. Tests use a
// shorter budget so the timeout path is fast.
func WithPerResolverTimeout(d time.Duration) Option {
	return func(v *verifier) { v.perResolverTTL = d }
}

type verifier struct {
	resolvers      []Resolver
	perResolverTTL time.Duration
}

// ErrInvalidInput is returned for empty hostname / token. The HTTP handler
// translates this to 400; callers should never see it unless the bloc
// passes garbage through.
var ErrInvalidInput = errors.New("dns verify: empty hostname or token")

// Verify queries every resolver in parallel and assembles the Report. The
// returned error is non-nil only for *catastrophic* failures (bad input,
// context cancellation upstream); a per-resolver network error is captured
// in the corresponding Result and the function returns success=false but
// err=nil so the HTTP handler can return 409 with the matrix.
func (v *verifier) Verify(ctx context.Context, hostname, token string, mode Mode) (Report, error) {
	hostname = strings.TrimSpace(hostname)
	token = strings.TrimSpace(token)
	if hostname == "" || token == "" {
		return Report{}, ErrInvalidInput
	}

	name := miekg.Fqdn("_boson." + hostname)
	needle := "boson-verify=" + token

	results := make(map[string]Result, len(v.resolvers))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, r := range v.resolvers {
		wg.Add(1)
		go func(r Resolver) {
			defer wg.Done()
			res := v.queryOne(ctx, r, name, needle)
			mu.Lock()
			results[r.Provider] = res
			mu.Unlock()
		}(r)
	}
	wg.Wait()

	matchCount := 0
	for _, res := range results {
		if res.Outcome == OutcomeMatch {
			matchCount++
		}
	}

	threshold := len(v.resolvers) // strict: 3 of 3
	if mode == ModeLenient {
		threshold = (len(v.resolvers) / 2) + 1 // 2 of 3
	}

	return Report{
		Success: matchCount >= threshold,
		Mode:    mode,
		Token:   token,
		Results: results,
	}, nil
}

func (v *verifier) queryOne(ctx context.Context, r Resolver, name, needle string) Result {
	// Bound each query by the per-resolver timeout AND the caller's
	// context — whichever cancels first wins. Important when the HTTP
	// handler has a tight overall deadline.
	queryCtx, cancel := context.WithTimeout(ctx, v.perResolverTTL)
	defer cancel()

	c := &miekg.Client{
		Net:     "tcp",
		Timeout: v.perResolverTTL,
	}

	m := new(miekg.Msg)
	m.SetQuestion(name, miekg.TypeTXT)
	m.RecursionDesired = true

	resp, _, err := c.ExchangeContext(queryCtx, m, r.Addr)
	if err != nil {
		if isTimeout(err) {
			return Result{Outcome: OutcomeTimeout, Detail: err.Error()}
		}
		// UDP fallback — some networks block outbound 53/tcp entirely.
		// We retry once over UDP before declaring a hard error.
		if udpErr := tryUDP(queryCtx, r, m); udpErr == nil {
			// Re-issue the original query path with UDP transport.
			c.Net = "udp"
			resp, _, err = c.ExchangeContext(queryCtx, m, r.Addr)
			if err != nil {
				return Result{Outcome: OutcomeError, Detail: err.Error()}
			}
		} else {
			return Result{Outcome: OutcomeError, Detail: err.Error()}
		}
	}

	if resp == nil {
		return Result{Outcome: OutcomeError, Detail: "no response from resolver"}
	}

	switch resp.Rcode {
	case miekg.RcodeSuccess:
		// fall through to record scan below
	case miekg.RcodeNameError: // NXDOMAIN — record literally doesn't exist
		return Result{Outcome: OutcomeMissingRecord, Detail: "NXDOMAIN"}
	default:
		return Result{Outcome: OutcomeError, Detail: fmt.Sprintf("rcode=%s", miekg.RcodeToString[resp.Rcode])}
	}

	// Collect every TXT string we saw from the answer section so the
	// caller can render "we found <these>, you wanted <token>".
	var observed []string
	for _, ans := range resp.Answer {
		txt, ok := ans.(*miekg.TXT)
		if !ok {
			continue
		}
		// A single TXT RR can carry multiple character-strings — joining
		// them with the empty separator matches Let's Encrypt's
		// validation behaviour and what most operators expect when
		// they paste a long token across multiple quoted strings.
		joined := strings.Join(txt.Txt, "")
		observed = append(observed, joined)
		if strings.Contains(joined, needle) {
			return Result{Outcome: OutcomeMatch, Records: observed}
		}
	}

	return Result{
		Outcome: OutcomeMissingRecord,
		Detail:  "no TXT record contained the expected token",
		Records: observed,
	}
}

// tryUDP probes whether the resolver is reachable via UDP. We only use it
// as a fallback signal when the TCP query failed; the actual UDP query is
// re-issued by queryOne with c.Net switched.
func tryUDP(ctx context.Context, r Resolver, m *miekg.Msg) error {
	c := &miekg.Client{Net: "udp", Timeout: 2 * time.Second}
	_, _, err := c.ExchangeContext(ctx, m, r.Addr)
	return err
}

// isTimeout collapses the several timeout-shaped errors miekg/dns can
// produce into a single boolean — context cancellation, context deadline
// hit, OR a net.Error reporting Timeout() (the common case for raw TCP
// read/write timeouts that don't wrap context). Without this, a slow /
// black-hole resolver lands in OutcomeError instead of OutcomeTimeout
// and the per-resolver matrix in the UI mis-attributes the failure.
func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return false
}
