//go:build !ios && !android

package main

import (
	"context"
	"strings"
)

// NetAuthService tells the renderer which auth service an IRC network uses
// ("Sign in to <network>"), from the network's /.well-known/boson.json (the
// same discovery voice uses), and lets the API proxy reach it. The renderer
// asks only for networks the user added or joined; the origin is validated
// here either way (ApiService.TrustNetworkAuth). Desktop only, like SSO.
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
	Main         bool   `json:"main"`
	Error        string `json:"error,omitempty"`
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
	out := NetworkAuthInfo{Host: d.Host}
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
	info, _, auth, dir := s.disc.fetchWellKnown(ctx, out.Domain)
	out.Voice, out.Auth, out.Directory = info, auth, dir
	return out
}
