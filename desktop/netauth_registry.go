package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync"
)

// Self-hosted networks' own auth services ("Sign in to <network>").
//
// The app's account lives on its own auth service (auth.boson.chat). A
// network that runs the boson stack names its auth service in its
// /.well-known/boson.json; once the user adds or joins that network, the
// app discovers it (netauth.go) and the proxy may reach that auth origin too,
// so the renderer can sign in there, refresh, get voice tokens, etc.
//
// The registry is that set of extra origins. An origin only gets in through
// discovery from a network's own domain, and only when it passes the same
// checks as a user directory (https, an exact origin, no IP literal in a
// private range, no wildcards).
//
// Tokens stay with the service that issued them: the renderer keeps one
// session per auth origin, and the proxy (tokenRealmOK) refuses a request
// whose bearer token was issued by one known sign-in service (the app's, or
// a network's) but is headed for another's realm — boson.chat tokens never
// reach a self-hosted network, and one network's never reach another.

// maxNetworkAuths bounds the registry.
const maxNetworkAuths = 32

type netAuths struct {
	mu sync.RWMutex
	// byOrigin: auth origin → its base URL (as discovered, maybe with a path).
	byOrigin map[string]string
}

func newNetAuths() *netAuths { return &netAuths{byOrigin: map[string]string{}} }

func (n *netAuths) add(origin, base string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if _, ok := n.byOrigin[origin]; !ok && len(n.byOrigin) >= maxNetworkAuths {
		return errors.New("too many sign-in services")
	}
	n.byOrigin[origin] = base
	return nil
}

func (n *netAuths) has(origin string) bool {
	if n == nil {
		return false
	}
	n.mu.RLock()
	defer n.mu.RUnlock()
	_, ok := n.byOrigin[origin]
	return ok
}

// trustedBase reports whether base (a cleaned auth base URL) is a network
// auth service the user's networks named.
func (n *netAuths) trustedBase(base string) bool {
	if n == nil {
		return false
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return false
	}
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.byOrigin[origin(u)] == base
}

// TrustNetworkAuth validates a network's auth service base URL and lets the
// proxy reach its origin. It returns the cleaned base, and main=true (and
// adds nothing) when it is the app's own auth service.
func (s *ApiService) TrustNetworkAuth(raw string) (base string, main bool, err error) {
	allowHTTP := s.policy.allowLoopback
	base, err = cleanBaseURL(raw, allowHTTP)
	if err != nil {
		return "", false, err
	}
	u, _ := url.Parse(base)
	o, err := s.directoryOrigin(origin(u))
	if err != nil {
		return "", false, err
	}
	if o == s.mainAuthOrigin() {
		return base, true, nil
	}
	if s.policy.origins[o] {
		// The app's API or directory: never a network's sign-in realm.
		return "", false, errors.New("not a sign-in service")
	}
	if err := s.nets.add(o, base); err != nil {
		return "", false, err
	}
	return base, false, nil
}

func (s *ApiService) mainAuthOrigin() string {
	s.dirs.mu.RLock()
	defer s.dirs.mu.RUnlock()
	return s.dirs.authOrigin
}

// realmOf is the sign-in service whose tokens u may receive (its origin),
// or "" when u isn't tied to one (a dev build's other loopback ports).
func (s *ApiService) realmOf(u *url.URL) string {
	o := origin(u)
	if s.nets.has(o) {
		return o
	}
	main := s.mainAuthOrigin()
	if s.policy.origins[o] {
		return main
	}
	s.dirs.mu.RLock()
	defer s.dirs.mu.RUnlock()
	if r, ok := s.dirs.realm[o]; ok {
		return r
	}
	if s.dirs.full[o] {
		return main
	}
	return ""
}

// knownRealm: an origin that issues tokens the app holds.
func (s *ApiService) knownRealm(o string) bool {
	return o != "" && (o == s.mainAuthOrigin() || s.nets.has(o))
}

// tokenRealmOK refuses a bearer token issued by one known sign-in service
// on its way to another's realm. Tokens it can't place (not a JWT, no iss,
// an issuer the app doesn't know) pass: the check only keeps the app's own
// sessions apart.
func (s *ApiService) tokenRealmOK(target *url.URL, headers map[string]string) bool {
	iss := bearerIssuerOrigin(headers)
	if !s.knownRealm(iss) {
		return true
	}
	realm := s.realmOf(target)
	return realm == "" || realm == iss
}

// bearerIssuerOrigin is the origin of the iss claim of a JWT bearer token
// in headers ("" when there's none). The token isn't verified: this only
// says where the app got it.
func bearerIssuerOrigin(headers map[string]string) string {
	var auth string
	for k, v := range headers {
		if strings.EqualFold(k, "Authorization") {
			auth = v
		}
	}
	tok, ok := strings.CutPrefix(auth, "Bearer ")
	if !ok {
		tok, ok = strings.CutPrefix(auth, "bearer ")
	}
	if !ok {
		return ""
	}
	parts := strings.Split(strings.TrimSpace(tok), ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return ""
	}
	var claims struct {
		Iss string `json:"iss"`
	}
	if json.Unmarshal(raw, &claims) != nil || claims.Iss == "" {
		return ""
	}
	u, err := url.Parse(claims.Iss)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	return origin(u)
}

func foreignToken() ApiResponse { return apiFail("Token for another sign-in service") }

// originOf is raw's scheme://host, or raw itself when it doesn't parse.
func originOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	return origin(u)
}
