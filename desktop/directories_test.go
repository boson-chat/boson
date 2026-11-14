package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestDirectoryAllowlist(t *testing.T) {
	ctx := context.Background()
	str := func(s string) *string { return &s }

	t.Run("default directory has full access", func(t *testing.T) {
		s := NewApiService("", false, defaultAuthBase, defaultDirectoryBase)
		if got := s.access(mustURL(t, "https://directory.boson.chat/v1/networks")); got != accessFull {
			t.Fatalf("access = %v", got)
		}
		if got := s.access(mustURL(t, "https://directory.boson.chat.evil.com/")); got != accessNone {
			t.Fatalf("lookalike access = %v", got)
		}
	})

	t.Run("validates directory origins", func(t *testing.T) {
		rel := NewApiService("", false)
		for _, bad := range []string{
			"http://dir.example.com",
			"https://user:pw@dir.example.com",
			"https://dir.example.com/path",
			"https://dir.example.com/?q=1",
			"https://dir.example.com/#x",
			"https://*.example.com",
			"https://10.0.0.5",
			"https://192.168.1.1",
			"https://169.254.169.254",
			"https://[::1]",
			"https://localhost",
			"ftp://dir.example.com",
			"dir.example.com",
			"",
		} {
			if _, err := rel.directoryOrigin(bad); err == nil {
				t.Errorf("%q accepted", bad)
			}
		}
		for in, want := range map[string]string{
			"https://Dir.Example.com":      "https://dir.example.com",
			"https://dir.example.com/":     "https://dir.example.com",
			"https://dir.example.com:8443": "https://dir.example.com:8443",
			"https://203.0.113.9":          "https://203.0.113.9",
		} {
			got, err := rel.directoryOrigin(in)
			if err != nil || got != want {
				t.Errorf("%q → %q, %v", in, got, err)
			}
		}
		dev := NewApiService("", true)
		if got, err := dev.directoryOrigin("http://localhost:4100"); err != nil || got != "http://localhost:4100" {
			t.Errorf("dev loopback: %q %v", got, err)
		}
	})

	t.Run("user directories are GET-only without credentials", func(t *testing.T) {
		var gotAuth, gotCookie string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotAuth, gotCookie = r.Header.Get("Authorization"), r.Header.Get("Cookie")
			_, _ = w.Write([]byte(r.Method))
		}))
		defer srv.Close()
		// Loopback stands in for the remote directory (dev build), with the
		// loopback blanket allowance off so only the list grants access.
		s := NewApiService("https://api.boson.chat", true)
		s.policy.allowLoopback = false
		if got := s.Fetch(ctx, ApiRequest{Method: "GET", URL: srv.URL + "/v1/networks"}); got.StatusText != "Blocked host" {
			t.Fatalf("before SetDirectories: %+v", got)
		}
		s.policy.allowLoopback = true
		if rej := s.SetDirectories([]DirectoryEntry{{URL: srv.URL}}); len(rej) != 0 {
			t.Fatalf("rejected %v", rej)
		}
		s.policy.allowLoopback = false
		got := s.Fetch(ctx, ApiRequest{Method: "GET", URL: srv.URL + "/v1/networks", Headers: map[string]string{"Authorization": "Bearer t", "Cookie": "c=1"}})
		if got.Text != "GET" || gotAuth != "" || gotCookie != "" {
			t.Fatalf("GET: %+v auth=%q cookie=%q", got, gotAuth, gotCookie)
		}
		for _, m := range []string{"POST", "PATCH", "PUT", "DELETE"} {
			if got := s.Fetch(ctx, ApiRequest{Method: m, URL: srv.URL + "/v1/networks", Body: str("{}")}); got.StatusText != "Blocked method" {
				t.Errorf("%s: %+v", m, got)
			}
		}
		// Replacing the list drops it again.
		s.SetDirectories(nil)
		if got := s.Fetch(ctx, ApiRequest{Method: "GET", URL: srv.URL}); got.StatusText != "Blocked host" {
			t.Fatalf("after removal: %+v", got)
		}
	})

	t.Run("owner access only when the well-known names our auth service", func(t *testing.T) {
		var issuer string
		var gotAuth string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/.well-known/boson-directory.json" {
				_, _ = w.Write([]byte(`{"name":"Friends","auth_issuer":"` + issuer + `"}`))
				return
			}
			gotAuth = r.Header.Get("Authorization")
			_, _ = w.Write([]byte(r.Method))
		}))
		defer srv.Close()

		for _, tc := range []struct {
			issuer string
			owner  bool
		}{
			{"https://auth.example.org", false},
			{"https://auth.boson.chat", true},
		} {
			issuer = tc.issuer
			gotAuth = ""
			s := NewApiService("https://api.boson.chat", true)
			s.TrustAuth("https://auth.boson.chat")
			s.SetDirectories([]DirectoryEntry{{URL: srv.URL, Owner: true}})
			s.policy.allowLoopback = false
			deadline := time.Now().Add(2 * time.Second)
			var got ApiResponse
			for {
				got = s.Fetch(ctx, ApiRequest{Method: "POST", URL: srv.URL + "/v1/networks", Headers: map[string]string{"Authorization": "Bearer t"}, Body: str("{}")})
				if got.OK || time.Now().After(deadline) {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if tc.owner && (got.Text != "POST" || gotAuth != "Bearer t") {
				t.Errorf("issuer %s: want owner access, got %+v auth=%q", tc.issuer, got, gotAuth)
			}
			if !tc.owner && got.StatusText != "Blocked method" {
				t.Errorf("issuer %s: want read-only, got %+v", tc.issuer, got)
			}
		}
	})

	t.Run("a read-only directory can't redirect a write or our token", func(t *testing.T) {
		var gotAuth string
		other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotAuth = r.Header.Get("Authorization")
			_, _ = w.Write([]byte("ok"))
		}))
		defer other.Close()
		s := NewApiService(other.URL, true) // `other` is the API (full access)
		dir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
		}))
		defer dir.Close()
		s.SetDirectories([]DirectoryEntry{{URL: dir.URL}})
		s.policy.allowLoopback = false
		got := s.Fetch(ctx, ApiRequest{Method: "GET", URL: dir.URL, Headers: map[string]string{"Authorization": "Bearer t"}})
		if got.Text != "ok" || gotAuth != "" {
			t.Fatalf("redirect: %+v auth=%q", got, gotAuth)
		}
	})

	t.Run("CheckDirectory fetches only the well-known", func(t *testing.T) {
		var paths []string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			paths = append(paths, r.URL.Path)
			_, _ = w.Write([]byte(`{"name":"Friends"}`))
		}))
		defer srv.Close()
		dev := NewApiService("", true)
		got := dev.CheckDirectory(ctx, srv.URL)
		if !got.OK || !strings.Contains(got.Text, "Friends") || len(paths) != 1 || paths[0] != "/.well-known/boson-directory.json" {
			t.Fatalf("got %+v paths %v", got, paths)
		}
		if got := NewApiService("", false).CheckDirectory(ctx, srv.URL); got.StatusText != "Blocked host" {
			t.Fatalf("release build reached loopback: %+v", got)
		}
		if got := dev.CheckDirectory(ctx, srv.URL+"/other"); got.StatusText != "Blocked host" {
			t.Fatalf("path accepted: %+v", got)
		}
	})
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
