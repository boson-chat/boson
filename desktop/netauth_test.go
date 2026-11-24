//go:build !ios && !android

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeJWT is an unsigned token with the given iss (the proxy only reads it).
func fakeJWT(iss string) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	return enc(map[string]string{"alg": "EdDSA", "typ": "at+jwt"}) + "." + enc(map[string]string{"iss": iss, "sub": "usr_1"}) + ".c2ln"
}

func TestTrustNetworkAuthValidates(t *testing.T) {
	s := NewApiService("https://api.boson.chat", false, defaultAuthBase, defaultDirectoryBase)
	s.TrustAuth(defaultAuthBase)
	for _, bad := range []string{
		"http://auth.example.org",           // not https
		"https://user:pw@auth.example.org",  // userinfo
		"https://auth.example.org/?q=1",     // query
		"https://auth.example.org/#f",       // fragment
		"https://*.example.org",             // wildcard
		"https://10.1.2.3",                  // private address
		"https://192.168.0.10",              // private address
		"https://169.254.169.254",           // link-local (metadata)
		"https://[::1]",                     // loopback in a release build
		"https://localhost:8443",            // loopback in a release build
		"ftp://auth.example.org",            // scheme
		"auth.example.org",                  // not absolute
		"https://api.boson.chat",            // the app's API is no sign-in realm
		"https://directory.boson.chat/auth", // nor its directory
	} {
		if _, _, err := s.TrustNetworkAuth(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
		if s.access(mustURL(t, strings.Replace(bad, "/#f", "", 1))) == accessFull && !strings.Contains(bad, "boson.chat") {
			t.Errorf("%q reachable after a refused trust", bad)
		}
	}

	base, main, err := s.TrustNetworkAuth("https://Auth.Example.org/")
	if err != nil || main || base != "https://auth.example.org" {
		t.Fatalf("good auth: %q %v %v", base, main, err)
	}
	if got := s.access(mustURL(t, "https://auth.example.org/v1/login")); got != accessFull {
		t.Fatalf("trusted auth access = %v", got)
	}
	if got := s.access(mustURL(t, "https://auth.example.org.evil.com/v1/login")); got != accessNone {
		t.Fatalf("lookalike access = %v", got)
	}

	base, main, err = s.TrustNetworkAuth("https://auth.boson.chat")
	if err != nil || !main || base != "https://auth.boson.chat" {
		t.Fatalf("the app's own auth: %q %v %v", base, main, err)
	}

	dev := NewApiService("http://127.0.0.1:13000", true)
	if _, _, err := dev.TrustNetworkAuth("http://127.0.0.1:18181"); err != nil {
		t.Fatalf("dev build, loopback http: %v", err)
	}
}

func TestTrustNetworkAuthIsBounded(t *testing.T) {
	s := NewApiService("", false, defaultAuthBase)
	for i := 0; i < maxNetworkAuths; i++ {
		if _, _, err := s.TrustNetworkAuth(fmt.Sprintf("https://auth%d.example.org", i)); err != nil {
			t.Fatalf("#%d: %v", i, err)
		}
	}
	if _, _, err := s.TrustNetworkAuth("https://one-more.example.org"); err == nil {
		t.Fatal("registry grew past its bound")
	}
	if _, _, err := s.TrustNetworkAuth("https://auth0.example.org"); err != nil {
		t.Fatalf("re-trusting a known one: %v", err)
	}
}

func TestTokenRealms(t *testing.T) {
	s := NewApiService("https://api.boson.chat", false, defaultAuthBase, defaultDirectoryBase)
	s.TrustAuth(defaultAuthBase)
	for _, a := range []string{"https://auth.net-a.org", "https://auth.net-b.org"} {
		if _, _, err := s.TrustNetworkAuth(a); err != nil {
			t.Fatal(err)
		}
	}
	bearer := func(iss string) map[string]string {
		return map[string]string{"Authorization": "Bearer " + fakeJWT(iss)}
	}
	cases := []struct {
		target, iss string
		ok          bool
	}{
		{"https://api.boson.chat/me", "https://auth.boson.chat", true},
		{"https://auth.boson.chat/v1/me", "https://auth.boson.chat", true},
		{"https://auth.net-a.org/v1/me", "https://auth.net-a.org", true},
		// boson.chat's token never goes to a network's auth service …
		{"https://auth.net-a.org/v1/me", "https://auth.boson.chat", false},
		// … a network's never to boson.chat's API, auth or directory …
		{"https://api.boson.chat/me", "https://auth.net-a.org", false},
		{"https://auth.boson.chat/v1/me", "https://auth.net-a.org", false},
		{"https://directory.boson.chat/v1/networks", "https://auth.net-a.org", false},
		// … nor to another network's.
		{"https://auth.net-b.org/v1/me", "https://auth.net-a.org", false},
		// Tokens the app doesn't hold pass (it can't place them).
		{"https://auth.net-a.org/v1/me", "https://elsewhere.example", true},
	}
	for _, c := range cases {
		if got := s.tokenRealmOK(mustURL(t, c.target), bearer(c.iss)); got != c.ok {
			t.Errorf("%s with a token from %s: ok=%v, want %v", c.target, c.iss, got, c.ok)
		}
	}
	if !s.tokenRealmOK(mustURL(t, "https://auth.net-a.org/v1/me"), map[string]string{"Authorization": "Bearer opaque"}) {
		t.Error("an opaque token was refused")
	}
	if !s.tokenRealmOK(mustURL(t, "https://auth.net-a.org/v1/me"), map[string]string{}) {
		t.Error("no token was refused")
	}
}

func TestFetchKeepsTokensInTheirRealm(t *testing.T) {
	ctx := context.Background()
	var mainHits, netHits atomic.Int32
	mainAuth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { mainHits.Add(1) }))
	defer mainAuth.Close()
	netAuth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		netHits.Add(1)
		if r.URL.Path == "/hop" {
			// A redirect onto the app's auth service with the network's token.
			http.Redirect(w, r, mainAuth.URL+"/v1/me", http.StatusTemporaryRedirect)
			return
		}
		_, _ = w.Write([]byte("net:" + r.Header.Get("Authorization")))
	}))
	defer netAuth.Close()

	s := NewApiService("http://127.0.0.1:1", true, mainAuth.URL)
	s.TrustAuth(mainAuth.URL)
	if _, main, err := s.TrustNetworkAuth(netAuth.URL); err != nil || main {
		t.Fatalf("trust: %v %v", main, err)
	}
	mainTok, netTok := fakeJWT(mainAuth.URL), fakeJWT(netAuth.URL)

	got := s.Fetch(ctx, ApiRequest{Method: "GET", URL: netAuth.URL + "/v1/me", Headers: map[string]string{"Authorization": "Bearer " + netTok}})
	if got.Text != "net:Bearer "+netTok {
		t.Fatalf("network token to its own auth: %+v", got)
	}
	before := netHits.Load()
	got = s.Fetch(ctx, ApiRequest{Method: "GET", URL: netAuth.URL + "/v1/me", Headers: map[string]string{"Authorization": "Bearer " + mainTok}})
	if got.OK || got.StatusText != "Token for another sign-in service" || netHits.Load() != before {
		t.Fatalf("boson token reached the network: %+v (hits %d→%d)", got, before, netHits.Load())
	}
	got = s.Fetch(ctx, ApiRequest{Method: "GET", URL: mainAuth.URL + "/v1/me", Headers: map[string]string{"Authorization": "Bearer " + netTok}})
	if got.OK || mainHits.Load() != 0 {
		t.Fatalf("network token reached boson's auth: %+v", got)
	}
	// Cross-origin redirects drop credentials, so the hop goes out without
	// the token (and isn't refused).
	got = s.Fetch(ctx, ApiRequest{Method: "GET", URL: netAuth.URL + "/hop", Headers: map[string]string{"Authorization": "Bearer " + netTok}})
	if !got.OK || mainHits.Load() != 1 {
		t.Fatalf("redirect hop: %+v (main hits %d)", got, mainHits.Load())
	}
}

func TestOwnerDirectoryOfANetwork(t *testing.T) {
	dir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"name":"Net dir","auth_issuer":"http://127.0.0.1:18181"}`))
	}))
	defer dir.Close()
	s := NewApiService("http://127.0.0.1:1", true, "http://127.0.0.1:18180")
	s.TrustAuth("http://127.0.0.1:18180")
	if _, _, err := s.TrustNetworkAuth("http://127.0.0.1:18181"); err != nil {
		t.Fatal(err)
	}
	s.SetDirectories([]DirectoryEntry{{URL: dir.URL, Owner: true}})
	s.dirs.mu.RLock()
	gen := s.dirs.gen
	s.dirs.mu.RUnlock()
	s.checkOwner(gen, originOf(dir.URL), originOf(dir.URL))
	u := mustURL(t, dir.URL+"/v1/networks")
	if r := s.realmOf(u); r != "http://127.0.0.1:18181" {
		t.Fatalf("realm = %q", r)
	}
	if s.tokenRealmOK(u, map[string]string{"Authorization": "Bearer " + fakeJWT("http://127.0.0.1:18180")}) {
		t.Fatal("the app's token may go to a directory that takes the network's accounts")
	}
	if !s.tokenRealmOK(u, map[string]string{"Authorization": "Bearer " + fakeJWT("http://127.0.0.1:18181")}) {
		t.Fatal("the network's token refused at its own directory")
	}
}

func TestNetAuthDiscover(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/selfhost.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"irc":{"host":"irc.selfhost.org","port":6697,"tls":true},"auth":{"url":"https://auth.selfhost.org"},"directory":{"url":"https://directory.selfhost.org"},"branding":"https://auth.selfhost.org/v1/branding"}`))
		case "/boson.chat/.well-known/boson.json":
			_, _ = w.Write([]byte(bosonJSON))
		case "/sneaky.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"auth":{"url":"https://10.0.0.8"}}`))
		case "/brandonly.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"branding":{"url":"https://brandonly.org/theme.json"}}`))
		case "/badbrand.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"branding":"http://badbrand.org/theme.json"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	d := testDiscoverer(t, srv, func(string) error { return errors.New("no") })
	api := NewApiService("https://api.boson.chat", false, defaultAuthBase)
	api.TrustAuth(defaultAuthBase)
	svc := NewNetAuthService(d, api)

	got := svc.Discover("irc.selfhost.org", false)
	if got.AuthURL != "https://auth.selfhost.org" || got.Main || got.DirectoryURL != "https://directory.selfhost.org" ||
		got.BrandingURL != "https://auth.selfhost.org/v1/branding" {
		t.Fatalf("self-hosted: %+v", got)
	}
	// Branding without accounts (the {"url": …} form), and a refused
	// plain-http branding URL in a release build.
	if got := svc.Discover("irc.brandonly.org", false); got.AuthURL != "" || got.BrandingURL != "https://brandonly.org/theme.json" {
		t.Fatalf("branding only: %+v", got)
	}
	if got := svc.Discover("irc.badbrand.org", false); got.BrandingURL != "" {
		t.Fatalf("http branding: %+v", got)
	}
	if api.access(mustURL(t, "https://auth.selfhost.org/v1/config")) != accessFull {
		t.Fatal("discovered auth not reachable")
	}
	if got := svc.Discover("irc.boson.chat", false); got.AuthURL != "https://auth.boson.chat" || !got.Main {
		t.Fatalf("boson.chat: %+v", got)
	}
	if got := svc.Discover("irc.sneaky.org", false); got.AuthURL != "" || got.Error == "" {
		t.Fatalf("private auth address: %+v", got)
	}
	if got := svc.Discover("irc.nothing.org", false); got.AuthURL != "" || got.Error != "" {
		t.Fatalf("no boson.json: %+v", got)
	}
}

func TestVoiceTrustedPerNetwork(t *testing.T) {
	v := NewVoiceService(t.TempDir(), "https://auth.boson.chat", false)
	v.nets = newNetAuths()
	ours := &VoiceInfo{Addr: "voice.selfhost.org:7700", URL: "https://voice.selfhost.org", AuthURL: "https://auth.selfhost.org"}
	if v.trusted(ours) {
		t.Fatal("a network's voice trusted before its auth was added")
	}
	_ = v.nets.add("https://auth.selfhost.org", "https://auth.selfhost.org")
	if !v.trusted(ours) {
		t.Fatal("voice under the network's own auth domain not trusted")
	}
	elsewhere := &VoiceInfo{Addr: "voice.other.org:7700", URL: "https://voice.selfhost.org", AuthURL: "https://auth.selfhost.org"}
	if v.trusted(elsewhere) {
		t.Fatal("voice host outside the auth's domain trusted")
	}
	boson := &VoiceInfo{Addr: "voice.boson.chat:7700", URL: "https://voice.boson.chat", AuthURL: "https://auth.boson.chat"}
	if !v.trusted(boson) {
		t.Fatal("boson.chat voice no longer trusted")
	}
}

func TestNormalizeServerAddress(t *testing.T) {
	for in, want := range map[string]string{
		"example.com":                     "example.com",
		"  Example.COM. ":                 "example.com",
		"irc.example.com":                 "irc.example.com",
		"irc.example.com:6697":            "irc.example.com",
		"https://example.com/":            "example.com",
		"https://Chat.Example.com:8443/x": "chat.example.com",
		"ircs://irc.example.com:6697":     "irc.example.com",
		"example.com/some/path":           "example.com",
		"localhost":                       "localhost",
	} {
		if got, ok := normalizeServerAddress(in); !ok || got != want {
			t.Errorf("%q → %q %v, want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "   ", "ftp://example.com", "https://user:pw@example.com", "exa mple.com", "-bad.com", "a..b", "https://", "ex_ample.com", "例子.com"} {
		if got, ok := normalizeServerAddress(bad); ok {
			t.Errorf("%q accepted as %q", bad, got)
		}
	}
}

func TestResolveCandidates(t *testing.T) {
	for in, want := range map[string]string{
		"example.com":         "example.com",
		"irc.example.com":     "example.com irc.example.com",
		"irc.net.example.com": "net.example.com irc.net.example.com",
		"localhost":           "",
		"10.0.0.1":            "",
	} {
		if got := strings.Join(resolveCandidates(in), " "); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func TestNetAuthResolve(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/selfhost.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"irc":{"host":"irc.selfhost.org","port":6697,"tls":true},"auth":{"url":"https://auth.selfhost.org"}}`))
		case "/deep.example.org/.well-known/boson.json":
			// Found on the host itself, IRC elsewhere: seeded for connect.
			_, _ = w.Write([]byte(`{"version":1,"irc":{"host":"irc.chat.example.org","port":6667,"tls":false},"auth":{"url":"https://auth.example.org"}}`))
		case "/plain.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"irc":{"host":"irc.plain.org","port":6697,"tls":true}}`))
		case "/noirc.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"auth":{"url":"https://auth.noirc.org"}}`))
		case "/lan.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"irc":{"host":"192.168.1.5","port":6697,"tls":true},"auth":{"url":"https://auth.lan.org"}}`))
		case "/sneaky.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`{"version":1,"irc":{"host":"irc.sneaky.org"},"auth":{"url":"https://10.0.0.8"}}`))
		case "/garbage.org/.well-known/boson.json":
			_, _ = w.Write([]byte(`<html>not json</html>`))
		case "/boson.chat/.well-known/boson.json":
			_, _ = w.Write([]byte(bosonJSON))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	d := testDiscoverer(t, srv, func(string) error { return errors.New("no") })
	api := NewApiService("https://api.boson.chat", false, defaultAuthBase)
	api.TrustAuth(defaultAuthBase)
	svc := NewNetAuthService(d, api)

	got := svc.Resolve("https://irc.selfhost.org/")
	if got.Error != "" || got.Domain != "selfhost.org" || got.AuthURL != "https://auth.selfhost.org" || got.Main ||
		got.IRC == nil || *got.IRC != (NetworkIRC{Host: "irc.selfhost.org", Port: 6697, TLS: true}) {
		t.Fatalf("self-hosted: %+v", got)
	}
	if api.access(mustURL(t, "https://auth.selfhost.org/v1/config")) != accessFull {
		t.Fatal("resolved auth not reachable")
	}

	got = svc.Resolve("deep.example.org")
	if got.Error != "" || got.Domain != "deep.example.org" || got.IRC == nil || got.IRC.Host != "irc.chat.example.org" || got.IRC.TLS {
		t.Fatalf("on the host itself: %+v", got)
	}
	// Connecting to its IRC host finds the same auth service.
	if info := svc.Discover("irc.chat.example.org", false); info.AuthURL != "https://auth.example.org" {
		t.Fatalf("seeded discovery: %+v", info)
	}

	if got := svc.Resolve("boson.chat"); !got.Main || got.Error != "" {
		t.Fatalf("boson.chat: %+v", got)
	}
	if got := svc.Resolve("plain.org"); got.Error != resolveNoAccounts || got.IRC == nil || got.IRC.Host != "irc.plain.org" {
		t.Fatalf("no accounts: %+v", got)
	}
	if got := svc.Resolve("noirc.org"); got.Error != resolveNoIRC {
		t.Fatalf("no irc: %+v", got)
	}
	if got := svc.Resolve("lan.org"); got.Error != resolveNoIRC || got.Detail == "" {
		t.Fatalf("private irc host: %+v", got)
	}
	if got := svc.Resolve("sneaky.org"); got.Error != resolveUntrusted || got.AuthURL != "" {
		t.Fatalf("private auth address: %+v", got)
	}
	if got := svc.Resolve("garbage.org"); got.Error != resolveNoDocument {
		t.Fatalf("invalid document: %+v", got)
	}
	if got := svc.Resolve("nothing.org"); got.Error != resolveNoDocument {
		t.Fatalf("404: %+v", got)
	}
	if got := svc.Resolve("not a host"); got.Error != resolveInvalid {
		t.Fatalf("invalid: %+v", got)
	}

	// Nobody answering is a different error from no boson.json.
	srv.Close()
	if got := svc.Resolve("gone.org"); got.Error != resolveUnreachable {
		t.Fatalf("unreachable: %+v", got)
	}
}

func TestNetAuthResolveOverride(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/boson.json"
	if err := os.WriteFile(path, []byte(`{"version":1,"irc":{"host":"localhost","port":16668,"tls":false},"auth":{"url":"http://127.0.0.1:18181"},"branding":"http://127.0.0.1:18999/branding.json"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	d := newVoiceDiscoverer(t.TempDir(), true)
	d.loadNetworkOverrides(path)
	api := NewApiService("http://127.0.0.1:13000", true)
	svc := NewNetAuthService(d, api)
	got := svc.Resolve("localhost")
	if got.Error != "" || got.AuthURL != "http://127.0.0.1:18181" || got.IRC == nil || *got.IRC != (NetworkIRC{Host: "localhost", Port: 16668}) ||
		got.BrandingURL != "http://127.0.0.1:18999/branding.json" {
		t.Fatalf("override: %+v", got)
	}
	if info := svc.Discover("localhost", false); info.BrandingURL != "http://127.0.0.1:18999/branding.json" {
		t.Fatalf("override discover: %+v", info)
	}
}

func TestNetAuthResolveUnreachableDetail(t *testing.T) {
	svc := &NetAuthService{}
	ctx := context.Background()
	if got := svc.unreachableDetail(ctx, "x.org"); got != "" {
		t.Fatalf("no resolver: %q", got)
	}
	svc.lookupHost = func(context.Context, string) ([]string, error) {
		return nil, &net.DNSError{Err: "no such host", Name: "typo.invalid", IsNotFound: true}
	}
	if got := svc.unreachableDetail(ctx, "typo.invalid"); got != resolveNotFound {
		t.Fatalf("typo: %q", got)
	}
	svc.lookupHost = func(context.Context, string) ([]string, error) { return []string{"192.0.2.1"}, nil }
	if got := svc.unreachableDetail(ctx, "irc.example.net"); got != resolveHostExists {
		t.Fatalf("plain irc host: %q", got)
	}
	svc.lookupHost = func(context.Context, string) ([]string, error) { return nil, errors.New("timeout") }
	if got := svc.unreachableDetail(ctx, "x.org"); got != "" {
		t.Fatalf("unknown: %q", got)
	}
}
