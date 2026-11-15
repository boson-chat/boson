package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// NetAuthService tells the renderer which auth service an IRC network uses
// ("Sign in to <network>"), from the network's /.well-known/boson.json (the
// same discovery voice uses), and lets the API proxy reach it. The renderer
// asks only for networks the user added or joined; the origin is validated
// here either way (ApiService.TrustNetworkAuth). On desktop and mobile.
type NetAuthService struct {
	disc *voiceDiscoverer
	api  *ApiService
}

// NetworkAuthInfo is Discover's answer. AuthURL is "" when the network
// names no (valid) auth service; Main is set when it's the app's own (its
// account is the boson.chat one). Error says why an auth.url was refused.
type NetworkAuthInfo struct {
	Host         string `json:"host"`
	AuthURL      string `json:"authUrl,omitempty"`
	DirectoryURL string `json:"directoryUrl,omitempty"`
	// BrandingURL is the network's theme document (boson.json branding),
	// whether or not it has accounts.
	BrandingURL string `json:"brandingUrl,omitempty"`
	Main        bool   `json:"main"`
	Error       string `json:"error,omitempty"`
}

func NewNetAuthService(disc *voiceDiscoverer, api *ApiService) *NetAuthService {
	return &NetAuthService{disc: disc, api: api}
}

// Discover looks host's network up (cached for a day unless refresh) and,
// when it names an auth service, allows the proxy to reach it.
func (s *NetAuthService) Discover(host string, refresh bool) NetworkAuthInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 3*voiceDiscoveryTimeout)
	defer cancel()
	d := s.lookup(ctx, host, refresh)
	out := NetworkAuthInfo{Host: d.Host, BrandingURL: d.Branding}
	auth := d.Auth
	if auth == "" && d.Voice != nil && d.Voice.Source != "probe" {
		// A cache entry from before auth was recorded on its own.
		auth = d.Voice.AuthURL
	}
	if auth == "" {
		return out
	}
	base, main, err := s.api.TrustNetworkAuth(auth)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.AuthURL, out.Main = base, main
	if d.Directory != "" {
		if _, err := s.api.directoryOrigin(originOf(d.Directory)); err == nil {
			out.DirectoryURL = d.Directory
		}
	}
	return out
}

// lookup is the network's discovery answer without holding up a connect for
// the voice probe: a fresh cached result (or a dev override) when there is
// one, else just the boson.json (which is all sign-in needs; voice discovery
// runs its own full check).
func (s *NetAuthService) lookup(ctx context.Context, rawHost string, refresh bool) *VoiceDiscovery {
	host := strings.ToLower(strings.TrimSpace(rawHost))
	if c := s.disc.cached(host); c != nil && !refresh && (c.Definitive || c.Voice != nil) && s.disc.now().Sub(c.CheckedAt) < voiceDiscoveryTTL {
		return c
	}
	out := &VoiceDiscovery{Host: host, Domain: voiceDomain(host)}
	if out.Domain == "" {
		return out
	}
	info, _, auth, dir, branding := s.disc.fetchWellKnownAll(ctx, out.Domain)
	out.Voice, out.Auth, out.Directory, out.Branding = info, auth, dir, branding
	return out
}

// "Use another server" on the login screen: the user names a network
// (example.com, irc.example.com, or a URL) instead of picking one from a
// list. Resolve finds its boson.json the way connect-time discovery does
// (its domain, then the host itself), validates its auth service like
// Discover (TrustNetworkAuth: https, an exact origin, no private
// addresses), and says where its IRC is.

// Resolve's error codes, for the renderer's wording.
const (
	resolveInvalid     = "invalid"       // not a host name
	resolveUnreachable = "unreachable"   // no answer from any candidate domain
	resolveNoDocument  = "no-boson-json" // answered, but no (valid) boson.json
	resolveNoAccounts  = "no-accounts"   // a boson.json without an auth service
	resolveUntrusted   = "untrusted"     // its auth service failed validation
	resolveNoIRC       = "no-irc"        // no IRC server to connect to
)

// NetworkServer is Resolve's answer. Error is one of the codes above (""
// when the network has accounts and an IRC server); IRC is still filled in
// for no-accounts when the boson.json names one, so the renderer can offer
// a guest connect.
type NetworkServer struct {
	// Host is the normalised address that was looked up.
	Host string `json:"host"`
	// Domain is where the boson.json was found ("" when none was).
	Domain       string      `json:"domain,omitempty"`
	IRC          *NetworkIRC `json:"irc,omitempty"`
	AuthURL      string      `json:"authUrl,omitempty"`
	DirectoryURL string      `json:"directoryUrl,omitempty"`
	BrandingURL  string      `json:"brandingUrl,omitempty"`
	Main         bool        `json:"main"`
	Error        string      `json:"error,omitempty"`
	Detail       string      `json:"detail,omitempty"`
}

// Resolve looks up the network the user typed.
func (s *NetAuthService) Resolve(address string) NetworkServer {
	host, ok := normalizeServerAddress(address)
	if !ok {
		return NetworkServer{Host: strings.TrimSpace(address), Error: resolveInvalid}
	}
	out := NetworkServer{Host: host}
	if o := s.disc.overrideNets[host]; o != nil {
		// Dev builds (BOSON_NETWORK_JSON): a network without a real domain.
		irc := *o.IRC
		out.Domain, out.IRC, out.BrandingURL = host, &irc, o.Branding
		return s.finishResolve(out, o.Auth, o.Directory)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*voiceDiscoveryTimeout)
	defer cancel()
	answered := false
	for _, domain := range resolveCandidates(host) {
		body, ans := s.disc.fetchWellKnownBody(ctx, domain)
		answered = answered || ans
		if body == nil {
			continue
		}
		var doc bosonWellKnown
		if json.Unmarshal(body, &doc) != nil || doc.Version != 1 {
			continue
		}
		out.Domain = domain
		out.BrandingURL = parseWellKnownBranding(body, s.disc.allowHTTP)
		if doc.IRC != nil {
			irc, err := s.cleanIRC(doc.IRC.Host, doc.IRC.Port, doc.IRC.TLS)
			if err != nil {
				out.Error, out.Detail = resolveNoIRC, err.Error()
				return out
			}
			out.IRC = irc
		} else if host != domain && voiceDomain(host) == domain {
			// No irc block: the IRC host the user typed (irc.example.com).
			out.IRC = &NetworkIRC{Host: host, Port: 6697, TLS: true}
		}
		auth, dir := parseWellKnownNetwork(body, s.disc.allowHTTP)
		if auth != "" && out.IRC != nil {
			s.seedDiscovery(out.IRC.Host, domain, body, auth, dir)
		}
		return s.finishResolve(out, auth, dir)
	}
	if answered {
		out.Error = resolveNoDocument
	} else {
		out.Error = resolveUnreachable
	}
	return out
}

func (s *NetAuthService) finishResolve(out NetworkServer, auth, dir string) NetworkServer {
	if auth == "" {
		out.Error = resolveNoAccounts
		return out
	}
	base, main, err := s.api.TrustNetworkAuth(auth)
	if err != nil {
		out.Error, out.Detail = resolveUntrusted, err.Error()
		return out
	}
	out.AuthURL, out.Main = base, main
	if dir != "" {
		if _, err := s.api.directoryOrigin(originOf(dir)); err == nil {
			out.DirectoryURL = dir
		}
	}
	if out.IRC == nil {
		out.Error = resolveNoIRC
	}
	return out
}

// cleanIRC validates a boson.json's irc block. Release builds refuse an IP
// literal in a private range (the user typed a domain, not their LAN).
func (s *NetAuthService) cleanIRC(rawHost string, port int, tls bool) (*NetworkIRC, error) {
	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(rawHost), "."))
	if host == "" || strings.ContainsAny(host, "/@ \t") {
		return nil, errors.New("irc.host is not a host name")
	}
	if port == 0 {
		port = 6697
	}
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("irc.port %d is out of range", port)
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil && !s.disc.allowHTTP {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
			return nil, errors.New("irc.host is a private address")
		}
	}
	return &NetworkIRC{Host: host, Port: port, TLS: tls}, nil
}

// seedDiscovery records what Resolve found for the network's IRC host when
// that host's own discovery would look elsewhere (irc.chat.example.com's
// boson.json is looked for on chat.example.com), so connecting to it finds
// the same auth service.
func (s *NetAuthService) seedDiscovery(ircHost, domain string, body []byte, auth, dir string) {
	if voiceDomain(ircHost) == domain {
		return
	}
	info, _ := parseWellKnown(body, s.disc.allowHTTP)
	s.disc.seed(&VoiceDiscovery{
		Host: ircHost, Domain: domain, Voice: info, Auth: auth, Directory: dir, Branding: parseWellKnownBranding(body, s.disc.allowHTTP),
		CheckedAt: s.disc.now(), Definitive: true,
	})
}

// resolveCandidates: where host's boson.json may be — its domain (as
// connect-time discovery looks), then the host itself.
func resolveCandidates(host string) []string {
	var out []string
	if d := voiceDomain(host); d != "" {
		out = append(out, d)
	}
	if voiceDomain(host) != "" && host != voiceDomain(host) {
		out = append(out, host)
	}
	return out
}

// normalizeServerAddress turns what the user typed into a lower-case host
// name: "example.com", "irc.example.com:6697", "https://example.com/x",
// "ircs://irc.example.com". false when it isn't one.
func normalizeServerAddress(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > 512 {
		return "", false
	}
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil || u.Host == "" || u.User != nil {
			return "", false
		}
		switch strings.ToLower(u.Scheme) {
		case "https", "http", "irc", "ircs":
		default:
			return "", false
		}
		s = u.Hostname()
	} else {
		if i := strings.IndexAny(s, "/?#"); i >= 0 {
			s = s[:i]
		}
		if h, _, err := net.SplitHostPort(s); err == nil {
			s = h
		}
	}
	s = strings.ToLower(strings.TrimSuffix(s, "."))
	if s == "" || len(s) > 253 {
		return "", false
	}
	for _, label := range strings.Split(s, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return "", false
			}
		}
	}
	return s, true
}
