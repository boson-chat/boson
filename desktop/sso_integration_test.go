package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"regexp"
	"testing"
)

// TestSSOAgainstAuthAndDex runs "Sign in with Dex" end to end against a
// real auth service and Dex: the loopback listener, PKCE, the browser's
// trip through Dex's login form (an HTTP client with a cookie jar stands in
// for the browser), and the code exchange. Opt-in:
//
//	BOSON_SSO_E2E_AUTH=http://127.0.0.1:18080 (auth with a "dex" OIDC
//	provider whose issuer is a Dex with the static user of
//	github.com/boson-chat/auth's test/dex/config.yaml) go test -run SSOAgainst
func TestSSOAgainstAuthAndDex(t *testing.T) {
	authURL := os.Getenv("BOSON_SSO_E2E_AUTH")
	if authURL == "" {
		t.Skip("BOSON_SSO_E2E_AUTH not set")
	}
	var cfg struct {
		SSOProviders []struct {
			Slug     string `json:"slug"`
			StartURL string `json:"start_url"`
		} `json:"sso_providers"`
	}
	getJSON(t, authURL+"/v1/config", &cfg)
	start := ""
	for _, p := range cfg.SSOProviders {
		if p.Slug == "dex" {
			start = p.StartURL
		}
	}
	if start == "" {
		t.Fatalf("no dex provider in %+v", cfg)
	}

	s := NewSSOService()
	b, err := s.Begin()
	if err != nil {
		t.Fatal(err)
	}
	verifier := ssoRandom(32)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	u, _ := url.Parse(start)
	q := u.Query()
	q.Set("return_to", b.RedirectURI)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	u.RawQuery = q.Encode()

	// The "browser": auth → Dex login form → Dex → auth callback → loopback.
	jar, _ := cookiejar.New(nil)
	browser := &http.Client{Jar: jar}
	resp, err := browser.Get(u.String())
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	m := regexp.MustCompile(`<form[^>]*action="([^"]+)"`).FindSubmatch(page)
	if m == nil {
		t.Fatalf("no Dex login form at %s: %s", resp.Request.URL, page)
	}
	action, _ := resp.Request.URL.Parse(html.UnescapeString(string(m[1])))
	resp, err = browser.PostForm(action.String(), url.Values{"login": {"dex.user@example.com"}, "password": {"dex-password"}})
	if err != nil {
		t.Fatal(err)
	}
	page, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.Request.URL.Host != mustHost(b.RedirectURI) || !bytes.Contains(page, []byte("close this tab")) {
		t.Fatalf("ended at %s: %s", resp.Request.URL, page)
	}

	res := s.Wait(b.ID)
	if res.Code == "" {
		t.Fatalf("no code: %+v", res)
	}
	// A wrong verifier burns the code; the right one gets a session.
	body, _ := json.Marshal(map[string]string{"code": res.Code, "code_verifier": verifier})
	resp, err = http.Post(authURL+"/v1/sso/exchange", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var tok struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		User         struct{ ID, Username string }
	}
	_ = json.NewDecoder(resp.Body).Decode(&tok)
	resp.Body.Close()
	if resp.StatusCode != 200 || tok.AccessToken == "" || tok.User.ID == "" {
		t.Fatalf("exchange %d %+v", resp.StatusCode, tok)
	}
	t.Logf("signed in as %s (%s)", tok.User.Username, tok.User.ID)

	// The code is single use.
	resp, _ = http.Post(authURL+"/v1/sso/exchange", "application/json", bytes.NewReader(body))
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("reused code: %d", resp.StatusCode)
	}
	// The new account lists its Dex identity.
	req, _ := http.NewRequest(http.MethodGet, authURL+"/v1/me/identities", nil)
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var ids struct {
		Identities []struct {
			ProviderSlug string `json:"provider_slug"`
		}
		HasPassword bool `json:"has_password"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&ids)
	resp.Body.Close()
	if len(ids.Identities) != 1 || ids.Identities[0].ProviderSlug != "dex" {
		t.Errorf("identities %+v", ids)
	}
}

func getJSON(t *testing.T, u string, v any) {
	t.Helper()
	resp, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

func mustHost(raw string) string {
	u, _ := url.Parse(raw)
	return u.Host
}
