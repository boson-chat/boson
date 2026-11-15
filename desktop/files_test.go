//go:build !ios && !android

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
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
			body, err := io.ReadAll(r.Body)
			if err != nil {
				return // cut off: not a file
			}
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
			w.Header().Set("X-File-Expires-At", "2026-11-17T12:00:00Z")
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
	// A body longer than declared is refused.
	tk = s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "b.bin", Size: 3})
	res, _ = http.Post(app.URL+tk.Path, "application/octet-stream", strings.NewReader("toolong"))
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("long body: %d", res.StatusCode)
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
	if res.Header.Get("X-File-Expires-At") != "2026-11-17T12:00:00Z" {
		t.Fatalf("X-File-Expires-At not passed on: %v", res.Header)
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

// postChunk POSTs one chunk of an upload (?offset=off).
func postChunk(t *testing.T, app, path string, off int64, chunk string) (int, string, http.Header) {
	t.Helper()
	res, err := http.Post(app+path+"?offset="+strconv.FormatInt(off, 10), "application/octet-stream", strings.NewReader(chunk))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b), res.Header
}

func TestFilesUploadChunksAssemble(t *testing.T) {
	host := &fakeFilesHost{}
	files := httptest.NewServer(host.handler(t))
	defer files.Close()
	s, _ := newTestFiles(t, nil)
	if _, err := s.trust(files.URL); err != nil {
		t.Fatal(err)
	}
	app := httptest.NewServer(assetHandler(fstest.MapFS{}, s))
	defer app.Close()

	var whole strings.Builder
	for i := 0; i < 250_000; i++ {
		whole.WriteByte(byte('a' + i%26))
	}
	body := whole.String()
	tk := s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "big.bin", Size: int64(len(body))})
	// Uneven chunks, the last one short.
	cuts := []int{0, 65_536, 65_537, 200_000, len(body)}
	for i := 0; i+1 < len(cuts); i++ {
		status, answer, hdr := postChunk(t, app.URL, tk.Path, int64(cuts[i]), body[cuts[i]:cuts[i+1]])
		last := i+2 == len(cuts)
		if !last && (status != http.StatusAccepted || hdr.Get(filesUploadMoreHeader) != "more" || !strings.Contains(answer, strconv.Itoa(cuts[i+1]))) {
			t.Fatalf("chunk %d: %d %v %s", i, status, hdr, answer)
		}
		if last && (status != http.StatusCreated || hdr.Get(filesUploadMoreHeader) != "" || !strings.Contains(answer, "/f/abc/big.bin")) {
			t.Fatalf("last chunk: %d %s", status, answer)
		}
	}
	host.mu.Lock()
	if len(host.uploads) != 1 || string(host.uploads[0].body) != body || host.uploads[0].length != int64(len(body)) {
		t.Fatalf("files host saw %d uploads", len(host.uploads))
	}
	host.mu.Unlock()

	// Out of order: refused, and the upload is over.
	tk = s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "c.bin", Size: 6})
	if status, _, _ := postChunk(t, app.URL, tk.Path, 3, "def"); status != http.StatusConflict {
		t.Fatalf("first chunk not at 0: %d", status)
	}
	if status, _, _ := postChunk(t, app.URL, tk.Path, 0, "abc"); status != http.StatusAccepted {
		t.Fatalf("chunk 0: %d", status)
	}
	if status, _, _ := postChunk(t, app.URL, tk.Path, 0, "abc"); status != http.StatusConflict {
		t.Fatalf("repeated chunk: %d", status)
	}
	if status, _, _ := postChunk(t, app.URL, tk.Path, 3, "def"); status != http.StatusNotFound {
		t.Fatalf("chunk after a failure: %d", status)
	}

	// Past the declared size, and an empty chunk (what WKWebView makes of
	// a Blob body): refused.
	tk = s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "d.bin", Size: 4})
	postChunk(t, app.URL, tk.Path, 0, "ab")
	if status, answer, _ := postChunk(t, app.URL, tk.Path, 2, "cde"); status != http.StatusBadRequest || !strings.Contains(answer, "size_mismatch") {
		t.Fatalf("overlong: %d %s", status, answer)
	}
	tk = s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "e.bin", Size: 4})
	if status, answer, _ := postChunk(t, app.URL, tk.Path, 0, ""); status != http.StatusBadRequest || !strings.Contains(answer, "empty_chunk") {
		t.Fatalf("empty: %d %s", status, answer)
	}
	host.mu.Lock()
	n := len(host.uploads)
	host.mu.Unlock()
	if n != 1 {
		t.Fatalf("a failed upload reached the files host whole (%d uploads)", n)
	}

	// Cancelled part-way: the next chunk finds no upload.
	tk = s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "f.bin", Size: 6})
	postChunk(t, app.URL, tk.Path, 0, "abc")
	s.CancelUpload(tk.ID)
	waitFor(t, func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.active) == 0 })
	if status, _, _ := postChunk(t, app.URL, tk.Path, 3, "def"); status != http.StatusNotFound {
		t.Fatalf("chunk after cancel: %d", status)
	}
}

// A files host that refuses an upload before reading it all: the chunk
// that's sent when it answers gets its answer.
func TestFilesUploadEarlyRefusal(t *testing.T) {
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "60")
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = io.WriteString(w, `{"error":"quota_exceeded"}`)
	}))
	defer files.Close()
	s, _ := newTestFiles(t, nil)
	if _, err := s.trust(files.URL); err != nil {
		t.Fatal(err)
	}
	app := httptest.NewServer(assetHandler(fstest.MapFS{}, s))
	defer app.Close()
	chunk := strings.Repeat("x", 1<<20)
	tk := s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "q.bin", Size: 8 << 20})
	for off := int64(0); off < 8<<20; off += 1 << 20 {
		status, answer, hdr := postChunk(t, app.URL, tk.Path, off, chunk)
		if status == http.StatusAccepted {
			continue
		}
		if status != http.StatusRequestEntityTooLarge || !strings.Contains(answer, "quota_exceeded") || hdr.Get("Retry-After") != "60" {
			t.Fatalf("refusal: %d %s %v", status, answer, hdr)
		}
		return
	}
	t.Fatal("the refusal never reached the renderer")
}

// A renderer that stops sending: the upload lapses.
func TestFilesUploadIdleLapses(t *testing.T) {
	host := &fakeFilesHost{}
	files := httptest.NewServer(host.handler(t))
	defer files.Close()
	s, _ := newTestFiles(t, nil)
	if _, err := s.trust(files.URL); err != nil {
		t.Fatal(err)
	}
	app := httptest.NewServer(assetHandler(fstest.MapFS{}, s))
	defer app.Close()
	tk := s.BeginUpload(FilesUploadRequest{FilesURL: files.URL, Name: "g.bin", Size: 6})
	postChunk(t, app.URL, tk.Path, 0, "abc")
	s.mu.Lock()
	st := s.active[tk.ID]
	s.mu.Unlock()
	st.idle.Reset(time.Millisecond)
	waitFor(t, func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.active) == 0 })
	if status, _, _ := postChunk(t, app.URL, tk.Path, 3, "def"); status != http.StatusNotFound {
		t.Fatalf("chunk after lapse: %d", status)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out")
}
