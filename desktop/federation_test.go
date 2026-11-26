//go:build !ios && !android

package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

const fedDoc = `{"version":1,"irc":{"host":"irc.fed.org","port":6697,"tls":true},"auth":{"url":"https://auth.fed.org"},
"federation":{"version":1,"issuer":"https://auth.fed.org","jwks_uri":"https://auth.fed.org/.well-known/jwks.json",
"assertion_endpoint":"https://auth.fed.org/v1/federation/assertions","login_endpoint":"https://auth.fed.org/v1/federation/login","accepts":"directory"}}`

func TestParseWellKnownFederation(t *testing.T) {
	f := parseWellKnownFederation([]byte(fedDoc), false)
	if f == nil || f.Issuer != "https://auth.fed.org" || f.Accepts != "directory" ||
		f.AssertionEndpoint != "https://auth.fed.org/v1/federation/assertions" || f.LoginEndpoint != "https://auth.fed.org/v1/federation/login" {
		t.Fatalf("parsed: %+v", f)
	}
	for name, doc := range map[string]string{
		"none":             `{"version":1}`,
		"bad version":      `{"version":1,"federation":{"version":2,"issuer":"https://auth.x.org","accepts":"open"}}`,
		"bad mode":         `{"version":1,"federation":{"version":1,"issuer":"https://auth.x.org","accepts":"everyone"}}`,
		"http issuer":      `{"version":1,"federation":{"version":1,"issuer":"http://auth.x.org","accepts":"open"}}`,
		"foreign endpoint": `{"version":1,"federation":{"version":1,"issuer":"https://auth.x.org","assertion_endpoint":"https://evil.org/a","accepts":"open"}}`,
		"doc version":      `{"version":2,"federation":{"version":1,"issuer":"https://auth.x.org","accepts":"open"}}`,
	} {
		if f := parseWellKnownFederation([]byte(doc), false); f != nil {
			t.Errorf("%s: accepted %+v", name, f)
		}
	}
	if f := parseWellKnownFederation([]byte(`{"version":1,"federation":{"version":1,"issuer":"https://auth.x.org"}}`), false); f == nil || f.Accepts != "off" {
		t.Errorf("missing accepts should read as off: %+v", f)
	}
}

func TestNetAuthFederation(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fed.org/.well-known/boson.json" {
			_, _ = w.Write([]byte(fedDoc))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	d := testDiscoverer(t, srv, func(string) error { return errors.New("no") })
	api := NewApiService("https://api.boson.chat", false, defaultAuthBase)
	api.TrustAuth(defaultAuthBase)
	svc := NewNetAuthService(d, api)

	got := svc.Discover("irc.fed.org", false)
	if got.Federation == nil || got.Federation.Domain != "fed.org" || got.Federation.Issuer != "https://auth.fed.org" {
		t.Fatalf("discover: %+v", got.Federation)
	}
	res := svc.Resolve("fed.org")
	if res.Error != "" || res.Federation == nil || res.Federation.Domain != "fed.org" || res.Federation.Accepts != "directory" {
		t.Fatalf("resolve: %+v %+v", res, res.Federation)
	}
}
