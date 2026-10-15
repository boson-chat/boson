package main

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestApiProxy(t *testing.T) {
	ctx := context.Background()
	str := func(s string) *string { return &s }

	t.Run("proxies an allowed request and returns status and text", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer t" {
				t.Errorf("auth header not forwarded")
			}
			b, _ := io.ReadAll(r.Body)
			w.WriteHeader(201)
			_, _ = w.Write([]byte(r.Method + ":" + string(b)))
		}))
		defer srv.Close()
		s := NewApiService(srv.URL, false)
		got := s.Fetch(ctx, ApiRequest{Method: "POST", URL: srv.URL + "/v1/x", Headers: map[string]string{"Authorization": "Bearer t"}, Body: str("hi")})
		if got.Status != 201 || !got.OK || got.Text != "POST:hi" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("forwards a binary body", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			_, _ = w.Write(b)
		}))
		defer srv.Close()
		raw := string([]byte{0, 1, 2, 255})
		got := NewApiService(srv.URL, false).Fetch(ctx, ApiRequest{Method: "PUT", URL: srv.URL, BodyBase64: str(base64.StdEncoding.EncodeToString([]byte(raw)))})
		if got.Text != raw {
			t.Fatalf("binary body: got %q", got.Text)
		}
	})

	t.Run("loopback only when allowed", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) }))
		defer srv.Close()
		if got := NewApiService("https://api.boson.chat", false).Fetch(ctx, ApiRequest{Method: "GET", URL: srv.URL}); got.StatusText != "Blocked host" {
			t.Fatalf("release build reached loopback: %+v", got)
		}
		if got := NewApiService("https://api.boson.chat", true).Fetch(ctx, ApiRequest{Method: "GET", URL: srv.URL}); got.Text != "ok" {
			t.Fatalf("dev build: %+v", got)
		}
	})

	t.Run("blocks everything off the exact-origin allowlist", func(t *testing.T) {
		s := NewApiService("", false) // defaults to the production API
		for _, u := range []string{
			"https://api.boson.chat.evil.com/x",
			"http://api.boson.chat/x",
			"https://api.boson.chat:8443/x",
			"https://example.com/",
			"http://169.254.169.254/",
		} {
			if got := s.Fetch(ctx, ApiRequest{Method: "GET", URL: u}); got.StatusText != "Blocked host" {
				t.Errorf("%s: got %+v", u, got)
			}
		}
		if got := s.Fetch(ctx, ApiRequest{Method: "GET", URL: "file:///etc/passwd"}); got.StatusText != "Bad URL" && got.StatusText != "Bad scheme" {
			t.Errorf("file url: got %+v", got)
		}
	})

	t.Run("refuses a redirect off the allowlist without fetching it", func(t *testing.T) {
		var hit atomic.Bool
		evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit.Store(true) }))
		defer evil.Close()
		api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, strings.Replace(evil.URL, "127.0.0.1", "localtest.example", 1), http.StatusFound)
		}))
		defer api.Close()
		got := NewApiService(api.URL, false).Fetch(ctx, ApiRequest{Method: "GET", URL: api.URL})
		if got.StatusText != "Blocked redirect host" || hit.Load() {
			t.Fatalf("got %+v (evil hit: %v)", got, hit.Load())
		}
	})

	t.Run("follows a same-origin redirect; 303 becomes a bodyless GET", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/start" {
				http.Redirect(w, r, "/end", http.StatusSeeOther)
				return
			}
			b, _ := io.ReadAll(r.Body)
			_, _ = w.Write([]byte(r.Method + ":" + string(b)))
		}))
		defer srv.Close()
		got := NewApiService(srv.URL, false).Fetch(ctx, ApiRequest{Method: "POST", URL: srv.URL + "/start", Body: str("x")})
		if got.Text != "GET:" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("strips Authorization and Cookie on a cross-origin redirect", func(t *testing.T) {
		second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte("auth=" + r.Header.Get("Authorization") + " cookie=" + r.Header.Get("Cookie") + " x=" + r.Header.Get("X-Keep")))
		}))
		defer second.Close()
		first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, second.URL, http.StatusFound)
		}))
		defer first.Close()
		// Both on loopback (allowed in dev), different ports = different origins.
		got := NewApiService("", true).Fetch(ctx, ApiRequest{Method: "GET", URL: first.URL, Headers: map[string]string{"Authorization": "Bearer t", "Cookie": "c=1", "X-Keep": "k"}})
		if got.Text != "auth= cookie= x=k" {
			t.Fatalf("got %q", got.Text)
		}
	})

	t.Run("stops after too many redirects", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/again", http.StatusFound)
		}))
		defer srv.Close()
		if got := NewApiService(srv.URL, false).Fetch(ctx, ApiRequest{Method: "GET", URL: srv.URL}); got.StatusText != "Too many redirects" {
			t.Fatalf("got %+v", got)
		}
	})

	t.Run("rejects a malformed request", func(t *testing.T) {
		s := NewApiService("", false)
		if got := s.Fetch(ctx, ApiRequest{}); got.StatusText != "Bad request" {
			t.Fatalf("got %+v", got)
		}
		if got := s.Fetch(ctx, ApiRequest{Method: "GET", URL: "::nope"}); got.StatusText != "Bad URL" {
			t.Fatalf("got %+v", got)
		}
	})
}
