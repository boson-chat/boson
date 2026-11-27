package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/boson-chat/quicvoice/wire"
	"github.com/quic-go/quic-go"
)

// Voice discovery: which IRC servers have voice, and where.
//
// A server's domain is its IRC host minus the first label (irc.boson.chat →
// boson.chat; a two-label host as it is). The domain's
// https://<domain>/.well-known/boson.json says where its voice server and
// auth service are. Without one, a QUIC handshake to voice.<domain>:7700
// with the quicvoice ALPN stands in. Neither → no voice for that server.
// Results are cached per IRC host, in memory and on disk, for a day.

const (
	voiceDiscoveryTimeout = 2 * time.Second
	voiceDiscoveryTTL     = 24 * time.Hour
	voiceDefaultPort      = "7700"
	voiceWellKnownMax     = 64 << 10
)

// VoiceInfo is where a server's voice lives.
type VoiceInfo struct {
	// Addr is the QUIC voice server, host:port.
	Addr string `json:"addr"`
	// URL is the voice server's HTTPS API (the room list).
	URL string `json:"url"`
	// AuthURL is the auth service that issues its voice tokens.
	AuthURL string `json:"authUrl"`
	// Source: "well-known", "probe" or "override" (dev builds).
	Source string `json:"source"`
}

// VoiceDiscovery is a server's discovery result; Voice is nil without voice.
type VoiceDiscovery struct {
	Host      string     `json:"host"`
	Domain    string     `json:"domain"`
	Voice     *VoiceInfo `json:"voice"`
	CheckedAt time.Time  `json:"checkedAt"`
	// Definitive: the domain answered (a boson.json, a 404, an invalid
	// document), rather than every check failing on the network. A failed
	// re-check doesn't replace a working answer with "no voice".
	Definitive bool `json:"definitive"`
	// Auth is the network's own auth service (boson.json auth.url, with or
	// without voice); Directory its network directory (directory.url), if
	// it names one. Both validated like voice.url. "" when absent.
	Auth      string `json:"auth,omitempty"`
	Directory string `json:"directory,omitempty"`
	// IRC is where the network's IRC server is (boson.json irc), when known.
	IRC *NetworkIRC `json:"irc,omitempty"`
	// Branding is the network's theme document URL (boson.json branding).
	Branding string `json:"branding,omitempty"`
	// Federation is the network's federated sign-in block (boson.json
	// federation), with Domain set; nil when absent or invalid.
	Federation *FederationInfo `json:"federation,omitempty"`
	// Files is the network's files host (boson.json files.url); set for dev
	// overrides only — FilesService reads live documents itself.
	Files string `json:"-"`
	// Push is the network's push relay (boson.json push.relay); set for
	// dev overrides only — PushService reads live documents itself.
	Push string `json:"-"`
}

// NetworkIRC is a boson.json's irc block.
type NetworkIRC struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	TLS  bool   `json:"tls"`
}

// voiceDomain derives the domain discovery looks at, or "" when there is
// none (an IP address, a single-label host like localhost).
func voiceDomain(host string) string {
	host = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if host == "" || net.ParseIP(strings.Trim(host, "[]")) != nil || strings.ContainsAny(host, "/:@ ") {
		return ""
	}
	labels := strings.Split(host, ".")
	for _, l := range labels {
		if l == "" {
			return ""
		}
	}
	switch len(labels) {
	case 1:
		return ""
	case 2:
		return host
	default:
		return strings.Join(labels[1:], ".")
	}
}

// bosonWellKnown is /.well-known/boson.json.
type bosonWellKnown struct {
	Version int `json:"version"`
	IRC     *struct {
		Host string `json:"host"`
		Port int    `json:"port"`
		TLS  bool   `json:"tls"`
	} `json:"irc"`
	Auth *struct {
		URL string `json:"url"`
	} `json:"auth"`
	Voice *struct {
		Addr string `json:"addr"`
		URL  string `json:"url"`
	} `json:"voice"`
	Directory *struct {
		URL string `json:"url"`
	} `json:"directory"`
	// Branding is the network's boson-theme/1 document (auth's
	// /v1/branding): a URL, or {"url": …}.
	Branding json.RawMessage `json:"branding"`
}

// parseWellKnownBranding reads a boson.json's branding URL ("" when absent
// or invalid): https, or http in dev builds; any path.
func parseWellKnownBranding(body []byte, allowHTTP bool) string {
	var doc bosonWellKnown
	if json.Unmarshal(body, &doc) != nil || doc.Version != 1 || len(doc.Branding) == 0 {
		return ""
	}
	var raw string
	if json.Unmarshal(doc.Branding, &raw) != nil {
		var obj struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(doc.Branding, &obj) != nil {
			return ""
		}
		raw = obj.URL
	}
	return cleanBrandingURL(raw, allowHTTP)
}

// cleanBrandingURL: an absolute https URL (http in dev builds) without
// credentials or fragment; "" otherwise.
func cleanBrandingURL(raw string, allowHTTP bool) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return ""
	}
	if u.Scheme != "https" && !(allowHTTP && u.Scheme == "http") {
		return ""
	}
	u.Host = strings.ToLower(u.Host)
	return u.String()
}

// parseWellKnownNetwork reads a boson.json's auth service and directory
// (each "" when absent or invalid). The document must be a valid version 1.
func parseWellKnownNetwork(body []byte, allowHTTP bool) (auth, directory string) {
	var doc bosonWellKnown
	if json.Unmarshal(body, &doc) != nil || doc.Version != 1 {
		return "", ""
	}
	if doc.Auth != nil {
		auth, _ = cleanBaseURL(doc.Auth.URL, allowHTTP)
	}
	if doc.Directory != nil {
		directory, _ = cleanBaseURL(doc.Directory.URL, allowHTTP)
	}
	return auth, directory
}

// parseWellKnown validates a boson.json; nil (and no error) when it's valid
// but has no voice.
func parseWellKnown(body []byte, allowHTTP bool) (*VoiceInfo, error) {
	var doc bosonWellKnown
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("boson.json: %w", err)
	}
	if doc.Version != 1 {
		return nil, fmt.Errorf("boson.json: unsupported version %d", doc.Version)
	}
	if doc.Voice == nil {
		return nil, nil
	}
	if doc.Auth == nil || doc.Auth.URL == "" {
		return nil, errors.New("boson.json: voice without auth.url")
	}
	if err := checkHostPort(doc.Voice.Addr); err != nil {
		return nil, fmt.Errorf("boson.json: voice.addr: %w", err)
	}
	voiceURL, err := cleanBaseURL(doc.Voice.URL, allowHTTP)
	if err != nil {
		return nil, fmt.Errorf("boson.json: voice.url: %w", err)
	}
	authURL, err := cleanBaseURL(doc.Auth.URL, allowHTTP)
	if err != nil {
		return nil, fmt.Errorf("boson.json: auth.url: %w", err)
	}
	return &VoiceInfo{Addr: strings.ToLower(doc.Voice.Addr), URL: voiceURL, AuthURL: authURL, Source: "well-known"}, nil
}

func checkHostPort(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "" {
		return errors.New("no host")
	}
	if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
		return fmt.Errorf("bad port %q", port)
	}
	return nil
}

type voiceDiscoverer struct {
	http      *http.Client
	probe     func(ctx context.Context, addr string) error
	now       func() time.Time
	path      string // persisted cache; "" keeps it in memory
	allowHTTP bool
	// override, dev builds: a boson.json for one IRC host
	// (BOSON_VOICE_JSON), so a local quicvoiced can be tried.
	override     *VoiceInfo
	overrideHost string
	// overrideNets: dev builds, BOSON_NETWORK_JSON — boson.json documents
	// for IRC hosts that have no real domain (the e2e stack's localhost),
	// keyed by their irc.host. Voice is optional in these.
	overrideNets map[string]*VoiceDiscovery
	// wellKnownURL builds the document's URL (tests point it elsewhere).
	wellKnownURL func(domain string) string

	mu    sync.Mutex
	cache map[string]*VoiceDiscovery
	// inflight: one check per host at a time.
	inflight map[string]*voiceCheck
}

type voiceCheck struct {
	done chan struct{}
	res  *VoiceDiscovery
}

func newVoiceDiscoverer(dataDir string, dev bool) *voiceDiscoverer {
	d := &voiceDiscoverer{
		http: &http.Client{
			Timeout: voiceDiscoveryTimeout,
			// The document must be where it's looked for.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		probe:        probeQuicvoice,
		now:          time.Now,
		allowHTTP:    dev,
		cache:        map[string]*VoiceDiscovery{},
		inflight:     map[string]*voiceCheck{},
		wellKnownURL: func(domain string) string { return "https://" + domain + "/.well-known/boson.json" },
	}
	if dataDir != "" {
		d.path = filepath.Join(dataDir, "voice-servers.json")
		d.load()
	}
	if dev {
		d.loadOverride(os.Getenv("BOSON_VOICE_JSON"))
		d.loadNetworkOverrides(os.Getenv("BOSON_NETWORK_JSON"))
	}
	return d
}

// loadNetworkOverrides reads dev-only boson.json files (a path list), each
// applying to its irc.host.
func (d *voiceDiscoverer) loadNetworkOverrides(paths string) {
	for _, path := range filepath.SplitList(paths) {
		if path == "" {
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "discovery: BOSON_NETWORK_JSON: %v\n", err)
			continue
		}
		var doc bosonWellKnown
		_ = json.Unmarshal(body, &doc)
		info, err := parseWellKnown(body, true)
		auth, dir := parseWellKnownNetwork(body, true)
		if err != nil || doc.IRC == nil || doc.IRC.Host == "" || auth == "" {
			fmt.Fprintf(os.Stderr, "discovery: %s needs irc.host and auth.url (%v)\n", path, err)
			continue
		}
		if info != nil {
			info.Source = "override"
		}
		host := strings.ToLower(doc.IRC.Host)
		if d.overrideNets == nil {
			d.overrideNets = map[string]*VoiceDiscovery{}
		}
		irc := &NetworkIRC{Host: host, Port: doc.IRC.Port, TLS: doc.IRC.TLS}
		d.overrideNets[host] = &VoiceDiscovery{Host: host, Domain: voiceDomain(host), Voice: info, Auth: auth, Directory: dir, IRC: irc, Branding: parseWellKnownBranding(body, true), Federation: parseWellKnownFederation(body, true).withDomain(voiceDomain(host)), Files: parseWellKnownFiles(body, true), Push: parseWellKnownPush(body, true), Definitive: true}
	}
}

// loadOverride reads a dev-only boson.json that applies to its irc.host.
func (d *voiceDiscoverer) loadOverride(path string) {
	if path == "" {
		return
	}
	body, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "voice: BOSON_VOICE_JSON: %v\n", err)
		return
	}
	var doc bosonWellKnown
	_ = json.Unmarshal(body, &doc)
	info, err := parseWellKnown(body, true)
	if err != nil || info == nil || doc.IRC == nil || doc.IRC.Host == "" {
		fmt.Fprintf(os.Stderr, "voice: BOSON_VOICE_JSON needs irc.host and voice (%v)\n", err)
		return
	}
	info.Source = "override"
	d.override, d.overrideHost = info, strings.ToLower(doc.IRC.Host)
}

// cached is the last result for host, fresh or not.
func (d *voiceDiscoverer) cached(host string) *VoiceDiscovery {
	host = strings.ToLower(host)
	if d.override != nil && host == d.overrideHost {
		return &VoiceDiscovery{Host: host, Domain: voiceDomain(host), Voice: d.override, Auth: d.override.AuthURL, CheckedAt: d.now(), Definitive: true}
	}
	if o := d.overrideNets[host]; o != nil {
		c := *o
		c.CheckedAt = d.now()
		return &c
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if r := d.cache[host]; r != nil {
		c := *r
		return &c
	}
	return nil
}

// seed stores a result found another way (Resolve), unless a fresh one
// for its host is already there.
func (d *voiceDiscoverer) seed(r *VoiceDiscovery) {
	d.mu.Lock()
	if prev := d.cache[r.Host]; prev != nil && prev.Auth != "" && d.now().Sub(prev.CheckedAt) < voiceDiscoveryTTL {
		d.mu.Unlock()
		return
	}
	d.cache[r.Host] = r
	d.mu.Unlock()
	d.save()
}

// Discover returns host's result: the cached one while it's under a day
// old (unless refresh), else a fresh check.
func (d *voiceDiscoverer) Discover(ctx context.Context, host string, refresh bool) *VoiceDiscovery {
	host = strings.ToLower(strings.TrimSpace(host))
	if c := d.cached(host); c != nil && (c.Voice != nil && c.Voice.Source == "override" || d.overrideNets[host] != nil ||
		!refresh && d.now().Sub(c.CheckedAt) < voiceDiscoveryTTL) {
		return c
	}
	d.mu.Lock()
	if chk := d.inflight[host]; chk != nil {
		d.mu.Unlock()
		select {
		case <-chk.done:
			c := *chk.res
			return &c
		case <-ctx.Done():
			return d.cached(host)
		}
	}
	chk := &voiceCheck{done: make(chan struct{})}
	d.inflight[host] = chk
	d.mu.Unlock()

	res := d.check(ctx, host)

	d.mu.Lock()
	prev := d.cache[host]
	// A check that only failed on the network keeps a working answer.
	if !res.Definitive && res.Voice == nil && prev != nil && prev.Voice != nil {
		kept := *prev
		res = &kept
	}
	d.cache[host] = res
	chk.res = res
	delete(d.inflight, host)
	d.mu.Unlock()
	close(chk.done)
	d.save()
	c := *res
	return &c
}

func (d *voiceDiscoverer) check(ctx context.Context, host string) *VoiceDiscovery {
	domain := voiceDomain(host)
	res := &VoiceDiscovery{Host: host, Domain: domain, CheckedAt: d.now()}
	if domain == "" {
		res.Definitive = true
		return res
	}
	info, answered, auth, dir, branding, fed := d.fetchWellKnownAll(ctx, domain)
	res.Auth, res.Directory, res.Branding, res.Federation = auth, dir, branding, fed.withDomain(domain)
	if info != nil {
		res.Voice, res.Definitive = info, true
		return res
	}
	// Fallback: is there a quicvoice server at voice.<domain>?
	addr := net.JoinHostPort("voice."+domain, voiceDefaultPort)
	pctx, cancel := context.WithTimeout(ctx, voiceDiscoveryTimeout)
	defer cancel()
	if err := d.probe(pctx, addr); err == nil {
		res.Voice = &VoiceInfo{
			Addr:    addr,
			URL:     "https://voice." + domain,
			AuthURL: "https://auth." + domain,
			Source:  "probe",
		}
		if res.Auth == "" {
			res.Auth = res.Voice.AuthURL
		}
		res.Definitive = true
		return res
	}
	res.Definitive = answered
	return res
}

// fetchWellKnownAll reads the domain's boson.json: its voice, auth service,
// directory and branding. answered: the server replied (even 404 or an
// invalid document), as opposed to a network error.
func (d *voiceDiscoverer) fetchWellKnownAll(ctx context.Context, domain string) (info *VoiceInfo, answered bool, auth, directory, branding string, fed *FederationInfo) {
	body, answered := d.fetchWellKnownBody(ctx, domain)
	if body == nil {
		return nil, answered, "", "", "", nil
	}
	auth, directory = parseWellKnownNetwork(body, d.allowHTTP)
	branding = parseWellKnownBranding(body, d.allowHTTP)
	fed = parseWellKnownFederation(body, d.allowHTTP)
	info, err := parseWellKnown(body, d.allowHTTP)
	if err != nil {
		return nil, true, auth, directory, branding, fed
	}
	return info, true, auth, directory, branding, fed
}

// fetchWellKnownBody is the domain's boson.json document (nil unless it
// answered 200 with a body under the size limit). answered: as above.
func (d *voiceDiscoverer) fetchWellKnownBody(ctx context.Context, domain string) (body []byte, answered bool) {
	ctx, cancel := context.WithTimeout(ctx, voiceDiscoveryTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.wellKnownURL(domain), nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("Accept", "application/json")
	resp, err := d.http.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, true
	}
	body, err = io.ReadAll(io.LimitReader(resp.Body, voiceWellKnownMax+1))
	if err != nil || len(body) > voiceWellKnownMax {
		return nil, true
	}
	return body, true
}

// probeQuicvoice completes a QUIC handshake with the quicvoice ALPN.
func probeQuicvoice(ctx context.Context, addr string) error {
	conn, err := quic.DialAddr(ctx, addr, &tls.Config{
		NextProtos: []string{wire.ALPN},
		MinVersion: tls.VersionTLS13,
	}, &quic.Config{HandshakeIdleTimeout: voiceDiscoveryTimeout})
	if err != nil {
		return err
	}
	return conn.CloseWithError(0, "probe")
}

func (d *voiceDiscoverer) load() {
	body, err := os.ReadFile(d.path)
	if err != nil {
		return
	}
	var saved map[string]*VoiceDiscovery
	if json.Unmarshal(body, &saved) != nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for host, r := range saved {
		if r == nil || r.Host != host {
			continue
		}
		// Re-validate what's on disk as strictly as a fresh answer.
		if r.Voice != nil && (checkHostPort(r.Voice.Addr) != nil || !validBase(r.Voice.URL, d.allowHTTP) || !validBase(r.Voice.AuthURL, d.allowHTTP)) {
			continue
		}
		if r.Auth != "" && !validBase(r.Auth, d.allowHTTP) || r.Directory != "" && !validBase(r.Directory, d.allowHTTP) {
			continue
		}
		if r.Branding != "" && cleanBrandingURL(r.Branding, d.allowHTTP) != r.Branding {
			r.Branding = ""
		}
		if r.Federation != nil {
			r.Federation = cleanFederation(r.Federation, d.allowHTTP)
		}
		d.cache[host] = r
	}
}

func validBase(raw string, allowHTTP bool) bool {
	_, err := cleanBaseURL(raw, allowHTTP)
	return err == nil
}

func (d *voiceDiscoverer) save() {
	if d.path == "" {
		return
	}
	d.mu.Lock()
	body, err := json.MarshalIndent(d.cache, "", "  ")
	d.mu.Unlock()
	if err != nil {
		return
	}
	tmp := d.path + ".tmp"
	if os.WriteFile(tmp, body, 0o600) == nil {
		_ = os.Rename(tmp, d.path)
	}
}
