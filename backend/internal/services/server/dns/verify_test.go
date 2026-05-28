package dns_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	miekg "github.com/miekg/dns"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	dnsverify "github.com/boson-chat/boson/backend/internal/services/server/dns"
)

// Stub DNS server backed by a configurable answer map keyed by query name.
// Tests construct one per scenario, point a Resolver at its address, and
// drive Verifier.Verify(). All three "resolvers" in tests are actually the
// same stub server with different Provider labels — that lets us write
// scenarios like "2 of 3 returned the token" by setting different answer
// behaviour per resolver-address even though the network reality is one
// server.
type stubServer struct {
	addr   string
	server *miekg.Server
	answer func(*miekg.Msg) *miekg.Msg
	mu     sync.Mutex
}

func newStub(t *testing.T, answer func(*miekg.Msg) *miekg.Msg) *stubServer {
	t.Helper()
	// 0 → kernel picks a port; using TCP because the verifier defaults
	// to "tcp" transport.
	pc, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	stub := &stubServer{
		addr:   pc.Addr().String(),
		answer: answer,
	}
	stub.server = &miekg.Server{
		Listener: pc,
		Net:      "tcp",
		Handler:  miekg.HandlerFunc(stub.handle),
	}
	ready := make(chan struct{})
	stub.server.NotifyStartedFunc = func() { close(ready) }
	go func() { _ = stub.server.ActivateAndServe() }()
	<-ready
	t.Cleanup(func() { _ = stub.server.Shutdown() })
	return stub
}

func (s *stubServer) handle(w miekg.ResponseWriter, req *miekg.Msg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	resp := s.answer(req)
	if resp == nil {
		// Simulate an empty response (silently drop) — caller sees a
		// timeout. Useful for OutcomeTimeout coverage.
		return
	}
	_ = w.WriteMsg(resp)
}

// answerWithTxt returns a builder that crafts a successful TXT response
// containing the given values. The first argument matches the value
// observed by the verifier (it concatenates the slice with the empty
// separator); subsequent slice entries simulate multi-string TXT RRs.
func answerWithTxt(values ...string) func(*miekg.Msg) *miekg.Msg {
	return func(req *miekg.Msg) *miekg.Msg {
		resp := new(miekg.Msg)
		resp.SetReply(req)
		resp.Rcode = miekg.RcodeSuccess
		for _, v := range values {
			rr := &miekg.TXT{
				Hdr: miekg.RR_Header{
					Name:   req.Question[0].Name,
					Rrtype: miekg.TypeTXT,
					Class:  miekg.ClassINET,
					Ttl:    300,
				},
				Txt: []string{v},
			}
			resp.Answer = append(resp.Answer, rr)
		}
		return resp
	}
}

func answerNXDomain() func(*miekg.Msg) *miekg.Msg {
	return func(req *miekg.Msg) *miekg.Msg {
		resp := new(miekg.Msg)
		resp.SetReply(req)
		resp.Rcode = miekg.RcodeNameError
		return resp
	}
}

func answerDrop() func(*miekg.Msg) *miekg.Msg {
	// Returning nil from the handler simulates a black-hole resolver
	// — useful for OutcomeTimeout coverage. The verifier's per-resolver
	// timeout closes the connection.
	return func(*miekg.Msg) *miekg.Msg { return nil }
}

func resolvers(stubs ...*stubServer) []dnsverify.Resolver {
	names := []string{"cloudflare", "google", "quad9"}
	out := make([]dnsverify.Resolver, len(stubs))
	for i, s := range stubs {
		out[i] = dnsverify.Resolver{Provider: names[i], Addr: s.addr}
	}
	return out
}

const testHostname = "irc.example.org"
const testToken = "abc123token"

func TestVerify_StrictAllMatch(t *testing.T) {
	stub := newStub(t, answerWithTxt("boson-verify="+testToken))
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(stub, stub, stub)),
		dnsverify.WithPerResolverTimeout(500*time.Millisecond),
	)
	report, err := v.Verify(context.Background(), testHostname, testToken, dnsverify.ModeStrict)
	require.NoError(t, err)
	assert.True(t, report.Success)
	for _, provider := range []string{"cloudflare", "google", "quad9"} {
		assert.Equal(t, dnsverify.OutcomeMatch, report.Results[provider].Outcome,
			"resolver %q should report match", provider)
	}
}

func TestVerify_StrictPartialMatchFails(t *testing.T) {
	good := newStub(t, answerWithTxt("boson-verify="+testToken))
	missing := newStub(t, answerNXDomain())
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(good, good, missing)),
		dnsverify.WithPerResolverTimeout(500*time.Millisecond),
	)
	report, err := v.Verify(context.Background(), testHostname, testToken, dnsverify.ModeStrict)
	require.NoError(t, err)
	assert.False(t, report.Success, "strict mode requires 3 of 3")
	assert.Equal(t, dnsverify.OutcomeMatch, report.Results["cloudflare"].Outcome)
	assert.Equal(t, dnsverify.OutcomeMatch, report.Results["google"].Outcome)
	assert.Equal(t, dnsverify.OutcomeMissingRecord, report.Results["quad9"].Outcome)
}

func TestVerify_LenientTwoOfThreeMatches(t *testing.T) {
	good := newStub(t, answerWithTxt("boson-verify="+testToken))
	missing := newStub(t, answerNXDomain())
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(good, good, missing)),
		dnsverify.WithPerResolverTimeout(500*time.Millisecond),
	)
	report, err := v.Verify(context.Background(), testHostname, testToken, dnsverify.ModeLenient)
	require.NoError(t, err)
	assert.True(t, report.Success, "lenient mode accepts 2 of 3")
}

func TestVerify_LenientOneOfThreeFails(t *testing.T) {
	good := newStub(t, answerWithTxt("boson-verify="+testToken))
	missing := newStub(t, answerNXDomain())
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(good, missing, missing)),
		dnsverify.WithPerResolverTimeout(500*time.Millisecond),
	)
	report, err := v.Verify(context.Background(), testHostname, testToken, dnsverify.ModeLenient)
	require.NoError(t, err)
	assert.False(t, report.Success, "lenient mode still needs 2 of 3")
}

func TestVerify_WrongTokenInRecord(t *testing.T) {
	wrong := newStub(t, answerWithTxt("boson-verify=different-token"))
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(wrong, wrong, wrong)),
		dnsverify.WithPerResolverTimeout(500*time.Millisecond),
	)
	report, err := v.Verify(context.Background(), testHostname, testToken, dnsverify.ModeStrict)
	require.NoError(t, err)
	assert.False(t, report.Success)
	for _, provider := range []string{"cloudflare", "google", "quad9"} {
		assert.Equal(t, dnsverify.OutcomeMissingRecord, report.Results[provider].Outcome,
			"provider %q should report missing_record (token mismatch)", provider)
	}
}

func TestVerify_MultiStringTxtConcatenates(t *testing.T) {
	// A single TXT RR can hold multiple character-strings — Let's Encrypt
	// and many CDN-issued challenges split long values that way. The
	// verifier should join them before scanning for the needle.
	half := "boson-verify=" + testToken[:5]
	rest := testToken[5:]
	answer := func(req *miekg.Msg) *miekg.Msg {
		resp := new(miekg.Msg)
		resp.SetReply(req)
		rr := &miekg.TXT{
			Hdr: miekg.RR_Header{
				Name:   req.Question[0].Name,
				Rrtype: miekg.TypeTXT,
				Class:  miekg.ClassINET,
				Ttl:    300,
			},
			Txt: []string{half, rest},
		}
		resp.Answer = []miekg.RR{rr}
		return resp
	}
	stub := newStub(t, answer)
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(stub, stub, stub)),
		dnsverify.WithPerResolverTimeout(500*time.Millisecond),
	)
	report, err := v.Verify(context.Background(), testHostname, testToken, dnsverify.ModeStrict)
	require.NoError(t, err)
	assert.True(t, report.Success)
}

func TestVerify_TimeoutOnBlackHoleResolver(t *testing.T) {
	good := newStub(t, answerWithTxt("boson-verify="+testToken))
	black := newStub(t, answerDrop())
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(good, good, black)),
		dnsverify.WithPerResolverTimeout(150*time.Millisecond),
	)
	report, err := v.Verify(context.Background(), testHostname, testToken, dnsverify.ModeStrict)
	require.NoError(t, err)
	assert.False(t, report.Success)
	// The black-hole resolver should land in the timeout outcome.
	assert.Equal(t, dnsverify.OutcomeTimeout, report.Results["quad9"].Outcome,
		"black-hole resolver should time out, got %+v", report.Results["quad9"])
}

func TestVerify_EmptyInputs(t *testing.T) {
	v := dnsverify.NewVerifier()
	_, err := v.Verify(context.Background(), "", testToken, dnsverify.ModeStrict)
	assert.True(t, errors.Is(err, dnsverify.ErrInvalidInput))

	_, err = v.Verify(context.Background(), testHostname, "", dnsverify.ModeStrict)
	assert.True(t, errors.Is(err, dnsverify.ErrInvalidInput))
}

func TestVerify_ContextCancelledMidQuery(t *testing.T) {
	// Cancel before issuing any query — verifier should still return
	// a Report with all resolvers as timeout/error and Success=false.
	stub := newStub(t, answerDrop())
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(stub, stub, stub)),
		dnsverify.WithPerResolverTimeout(5*time.Second),
	)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	report, err := v.Verify(ctx, testHostname, testToken, dnsverify.ModeStrict)
	require.NoError(t, err)
	assert.False(t, report.Success)
}

func TestAlwaysSucceedVerifier_AlwaysReturnsMatch(t *testing.T) {
	// Dev-mode bypass — used by the API when SKIP_DNS_VERIFY=true. The
	// shape of the returned Report matters: it has to look like a
	// real "matched on all three resolvers" outcome so the rest of
	// the service code path (status transitions, /verify HTTP 200)
	// behaves identically to a successful real verify.
	v := dnsverify.AlwaysSucceedVerifier{}
	report, err := v.Verify(context.Background(), "anything.localhost", "garbage-token", dnsverify.ModeStrict)
	require.NoError(t, err)
	assert.True(t, report.Success)
	for _, provider := range []string{"cloudflare", "google", "quad9"} {
		assert.Equal(t, dnsverify.OutcomeMatch, report.Results[provider].Outcome,
			"bypass verifier must report match on every resolver, got %+v", report.Results[provider])
	}
}

// Sanity-check the public Report JSON shape — the HTTP handler returns it
// verbatim on 409, so accidental field renames would silently break the
// client matrix UI.
func TestReport_JSONStability(t *testing.T) {
	good := newStub(t, answerWithTxt("boson-verify="+testToken))
	v := dnsverify.NewVerifier(
		dnsverify.WithResolvers(resolvers(good, good, good)),
		dnsverify.WithPerResolverTimeout(500*time.Millisecond),
	)
	report, err := v.Verify(context.Background(), testHostname, testToken, dnsverify.ModeStrict)
	require.NoError(t, err)
	for _, r := range report.Results {
		assert.NotEmpty(t, r.Outcome, "every result should carry an Outcome")
	}
	// The Report itself should have stable field names. We don't snapshot
	// the JSON because the resolver map ordering is non-deterministic;
	// we just confirm Success/Results are accessible.
	assert.True(t, report.Success)
	assert.Len(t, report.Results, 3)
}

// fmt is intentionally unused after the cleanup — silencing the import lint.
var _ = fmt.Sprintf
