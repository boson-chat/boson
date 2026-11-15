//go:build !ios && !android

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

// fakeFilesHost records uploads and serves /f/ files.
type fakeFilesHost struct {
	mu      sync.Mutex
	uploads []struct {
		name, ctype, auth string
		body              []byte
		length            int64
	}
}

func (f *fakeFilesHost) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/config":
			_, _ = io.WriteString(w, `{"enabled":true,"guest_enabled":true}`)
		case r.URL.Path == "/v1/guest-token" && r.Method == http.MethodPost:
			_, _ = io.WriteString(w, `{"token":"g1"}`)
		case r.URL.Path == "/v1/files" && r.Method == http.MethodPost:
			body, _ := io.ReadAll(r.Body)
			name, _ := url.PathUnescape(r.Header.Get("X-Filename"))
			f.mu.Lock()
			f.uploads = append(f.uploads, struct {
				name, ctype, auth string
				body              []byte
				length            int64
			}{name, r.Header.Get("Content-Type"), r.Header.Get("Authorization"), body, r.ContentLength})
			f.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "abc", "url": "http://" + r.Host + "/f/abc/" + url.PathEscape(name), "size": len(body)})
		case strings.HasPrefix(r.URL.Path, "/f/gone/"):
			w.WriteHeader(http.StatusGone)
		case strings.HasPrefix(r.URL.Path, "/f/"):
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Cache-Control", "public, max-age=3600")
			w.Header().Set("Content-Disposition", "inline")
			http.ServeContent(w, r, "x.png", time.Time{}, strings.NewReader("0123456789"))
		default:
			http.NotFound(w, r)
		}
	})
}

func newTestFiles(t *testing.T, wellKnown map[string]string) (*FilesService, *httptest.Server) {
	t.Helper()
	wk := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		domain := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")[0]
		body, ok := wellKnown[domain]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(wk.Close)
	disc := newVoiceDiscoverer("", true)
	disc.wellKnownURL = func(domain string) string { return wk.URL + "/" + domain + "/.well-known/boson.json" }
	api := NewApiService("https://api.boson.chat", true, defaultAuthBase, defaultDirectoryBase)
	api.TrustAuth(defaultAuthBase)
	s := NewFilesService(disc, api, true)
	s.emit = func(string, any) {}
	return s, wk
}

func TestFilesDiscoverWellKnownThenAuth(t *testing.T) {
	host := &fakeFilesHost{}
	files := httptest.NewServer(host.handler(t))
	defer files.Close()
	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/config" {
			_, _ = io.WriteString(w, `{"files_url":"`+files.URL+`"}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer auth.Close()
	s, _ := newTestFiles(t, map[string]string{
		"one.example":   `{"version":1,"files":{"url":"` + files.URL + `/"}}`,
		"two.example":   `{"version":1,"auth":{"url":"` + auth.URL + `"}}`,
		"three.example": `{"version":1}`,
	})
	if got := s.Discover("irc.one.example", false); got.FilesURL != files.URL || got.Source != "well-known" {
		t.Fatalf("well-known: %+v", got)
	}
	if got := s.Discover("irc.two.example", false); got.FilesURL != files.URL || got.Source != "auth" {
		t.Fatalf("auth fallback: %+v", got)
	}
	if got := s.Discover("irc.three.example", false); got.FilesURL != "" {
		t.Fatalf("no files: %+v", got)
	}
}

func TestFilesTrustRefusesAppOrigins(t *testing.T) {
	s, _ := newTestFiles(t, nil)
	s.dev = false
	for _, bad := range []string{
		"http://files.example.org",       // not https
		"https://10.0.0.1",               // private
		"https://localhost:8443",         // loopback in a release build
		"https://api.boson.chat",         // the app's API
		"https://auth.boson.chat",        // the app's auth service
		"https://files.example.org/?x=1", // not a base URL
	} {
		if _, err := s.trust(bad); err == nil {
			t.Errorf("%q trusted", bad)
		}
	}
	if base, err := s.trust("https://Files.Example.org/"); err != nil || base != "https://files.example.org" {
		t.Fatalf("good host: %q %v", base, err)
	}
}

func TestFilesRequestAllowlist(t *testing.T) {
	host := &fakeFilesHost{}
	files := httptest.NewServer(host.handler(t))
	defer files.Close()
	s, _ := newTestFiles(t, nil)
	if r := s.Request(FilesRequest{FilesURL: files.URL, Method: "GET", Path: "/v1/config"}); r.Error == "" {
		t.Fatal("untrusted host reached")
	}
	if _, err := s.trust(files.URL); err != nil {
		t.Fatal(err)
	}
	if r := s.Request(FilesRequest{FilesURL: files.URL, Method: "GET", Path: "/v1/config"}); r.Status != 200 || !strings.Contains(r.Body, "enabled") {
		t.Fatalf("config: %+v", r)
	}
	if r := s.Request(FilesRequest{FilesURL: files.URL, Method: "POST", Path: "/v1/guest-token"}); r.Status != 200 {
		t.Fatalf("guest token: %+v", r)
	}
	if r := s.Request(FilesRequest{FilesURL: files.URL, Method: "DELETE", Path: "/v1/files/x"}); r.Error == "" {
		t.Fatal("call outside the allowlist made")
	}
	if r := s.Request(FilesRequest{FilesURL: files.URL, Method: "GET", Path: "/v1/me/usage", Auth: "Basic abc"}); r.Error == "" {
		t.Fatal("odd credentials passed")
	}
}

func TestFilesUploadStreamsWithProgress(t *testing.T) {
	host := &fakeFilesHost{}
	files := httptest.NewServer(host.handler(t))
	defer files.Close()
	s, _ := newTestFiles(t, nil)
	var mu sync.Mutex
	var events []FilesProgress
	s.emit = func(_ string, d any) {
		mu.Lock()
		events = append(events, d.(FilesProgress))
		mu.Unlock()
	}
	if tk := s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "a.txt", Size: 3}); tk.Error == "" {
		t.Fatal("untrusted upload accepted")
	}
	if _, err := s.trust(files.URL); err != nil {
		t.Fatal(err)
	}
	app := httptest.NewServer(assetHandler(fstest.MapFS{}, s))
	defer app.Close()
	body := strings.Repeat("x", 100_000)
	tk := s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Auth: "Guest g1", Name: "../My photo?.png", Type: "image/png", Size: int64(len(body))})
	if tk.Error != "" || !strings.HasPrefix(tk.Path, "/_boson/files/upload/") {
		t.Fatalf("ticket: %+v", tk)
	}
	res, err := http.Post(app.URL+tk.Path, "application/octet-stream", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	answer, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusCreated || !strings.Contains(string(answer), "/f/abc/My%20photo.png") {
		t.Fatalf("upload: %d %s", res.StatusCode, answer)
	}
	host.mu.Lock()
	up := host.uploads[0]
	host.mu.Unlock()
	if up.name != "My photo.png" || up.ctype != "image/png" || up.auth != "Guest g1" || len(up.body) != len(body) || up.length != int64(len(body)) {
		t.Fatalf("files host saw %q %q %q %d/%d", up.name, up.ctype, up.auth, len(up.body), up.length)
	}
	mu.Lock()
	last := events[len(events)-1]
	mu.Unlock()
	if last.ID != tk.ID || last.Sent != int64(len(body)) || last.Total != int64(len(body)) {
		t.Fatalf("last progress %+v", last)
	}

	// A ticket is single-use.
	res, _ = http.Post(app.URL+tk.Path, "application/octet-stream", strings.NewReader(body))
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("reused ticket: %d", res.StatusCode)
	}
	// A body that isn't the declared size is refused.
	tk = s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "b.bin", Size: 10})
	res, _ = http.Post(app.URL+tk.Path, "application/octet-stream", strings.NewReader("short"))
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("short body: %d", res.StatusCode)
	}
	// Cancelled before use: gone.
	tk = s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "c.bin", Size: 1})
	s.CancelUpload(tk.ID)
	res, _ = http.Post(app.URL+tk.Path, "application/octet-stream", strings.NewReader("x"))
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("cancelled ticket: %d", res.StatusCode)
	}
}

func TestFilesViewProxy(t *testing.T) {
	host := &fakeFilesHost{}
	files := httptest.NewServer(host.handler(t))
	defer files.Close()
	other := httptest.NewServer(host.handler(t))
	defer other.Close()
	s, _ := newTestFiles(t, nil)
	if _, err := s.trust(files.URL); err != nil {
		t.Fatal(err)
	}
	app := httptest.NewServer(assetHandler(fstest.MapFS{}, s))
	defer app.Close()
	get := func(raw string, hdr map[string]string) *http.Response {
		req, _ := http.NewRequest(http.MethodGet, app.URL+filesViewPath(raw), nil)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	res := get(files.URL+"/f/abc/x.png", map[string]string{"Range": "bytes=2-4"})
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusPartialContent || string(b) != "234" {
		t.Fatalf("range: %d %q", res.StatusCode, b)
	}
	if res.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.HasPrefix(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("headers: %v", res.Header)
	}
	if res.Header.Get("Cache-Control") != "public, max-age=3600" {
		t.Fatalf("cache-control not passed on: %v", res.Header)
	}
	if res = get(files.URL+"/f/gone/x.png", nil); res.StatusCode != http.StatusGone {
		t.Fatalf("expired: %d", res.StatusCode)
	}
	if res = get(other.URL+"/f/abc/x.png", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("other host: %d", res.StatusCode)
	}
	if res = get(files.URL+"/v1/me/usage", nil); res.StatusCode != http.StatusForbidden {
		t.Fatalf("non-file path: %d", res.StatusCode)
	}
}

func TestCleanUploadName(t *testing.T) {
	for in, want := range map[string]string{
		"photo.png":                        "photo.png",
		"../../etc/passwd":                 "passwd",
		`C:\Users\me\a b.txt`:              "a b.txt",
		"bad<>:\"|?*name.zip":              "badname.zip",
		"  .hidden  ":                      "hidden",
		"\x00\x07":                         "file",
		strings.Repeat("a", 300) + ".jpeg": strings.Repeat("a", 195) + ".jpeg",
	} {
		if got := cleanUploadName(in); got != want {
			t.Errorf("cleanUploadName(%q) = %q, want %q", in, got, want)
		}
	}
}
