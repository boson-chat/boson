//go:build !ios && !android

package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

// testPNG is a w×h PNG of noise (so it doesn't compress to nothing).
func testPNG(t *testing.T, w, h int, seed uint32) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	x := seed*2654435761 | 1
	for i := 0; i < len(img.Pix); i += 4 {
		x ^= x << 13
		x ^= x >> 17
		x ^= x << 5
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = byte(x), byte(x>>8), byte(x>>16), 0xff
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// imageHost serves /img/<name> with per-path headers; counts requests.
type imageHost struct {
	mu      sync.Mutex
	bodies  map[string][]byte
	headers map[string]http.Header
	status  map[string]int
	hits    map[string]int
	cond    map[string]int // conditional requests seen
	down    atomic.Bool
}

func newImageHost(t *testing.T) (*imageHost, *httptest.Server) {
	h := &imageHost{bodies: map[string][]byte{}, headers: map[string]http.Header{}, status: map[string]int{}, hits: map[string]int{}, cond: map[string]int{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.down.Load() {
			hj, _ := w.(http.Hijacker)
			c, _, _ := hj.Hijack()
			c.Close()
			return
		}
		h.mu.Lock()
		h.hits[r.URL.Path]++
		body, hdr, st := h.bodies[r.URL.Path], h.headers[r.URL.Path], h.status[r.URL.Path]
		if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
			h.cond[r.URL.Path]++
		}
		h.mu.Unlock()
		for k, v := range hdr {
			w.Header()[k] = v
		}
		if st != 0 {
			w.WriteHeader(st)
			return
		}
		if body == nil {
			http.NotFound(w, r)
			return
		}
		if et := hdr.Get("ETag"); et != "" && r.Header.Get("If-None-Match") == et {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return h, srv
}

func (h *imageHost) set(path string, body []byte, hdr map[string]string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.bodies[path] = body
	hh := http.Header{}
	for k, v := range hdr {
		hh.Set(k, v)
	}
	h.headers[path] = hh
}

func (h *imageHost) count(path string) (int, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.hits[path], h.cond[path]
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func newTestCache(t *testing.T, dir string, limitMB int) (*ImageCacheService, *fakeClock) {
	t.Helper()
	t.Setenv("BOSON_IMAGE_CACHE_MB", strconv.Itoa(limitMB))
	clock := &fakeClock{t: time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)}
	c := NewImageCacheService(dir, filepath.Join(dir, "settings.json"), true)
	c.now = clock.now
	if c.storeErr != nil {
		t.Fatal(c.storeErr)
	}
	return c, clock
}

// fetchImage asks the cache's route for raw and returns the answer.
func fetchImage(t *testing.T, app *httptest.Server, kind, raw string, box ...int) (*http.Response, []byte) {
	t.Helper()
	q := url.Values{"k": {kind}, "u": {raw}}
	if len(box) == 2 {
		q.Set("w", strconv.Itoa(box[0]))
		q.Set("h", strconv.Itoa(box[1]))
	}
	res, err := http.Get(app.URL + imageRoute + "?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res, b
}

func serveCache(t *testing.T, c *ImageCacheService) *httptest.Server {
	app := httptest.NewServer(assetHandler(fstest.MapFS{}, nil, c))
	t.Cleanup(app.Close)
	return app
}

func TestImageCacheHitMissAndDimensions(t *testing.T) {
	host, srv := newImageHost(t)
	body := testPNG(t, 40, 30, 1)
	host.set("/img/a.png", body, map[string]string{"Cache-Control": "max-age=600", "Content-Type": "image/png"})
	c, _ := newTestCache(t, t.TempDir(), 50)
	app := serveCache(t, c)

	res, got := fetchImage(t, app, "web", srv.URL+"/img/a.png")
	if res.StatusCode != 200 || !bytes.Equal(got, body) {
		t.Fatalf("first: %d, %d bytes", res.StatusCode, len(got))
	}
	if res.Header.Get("X-Boson-Cache") != "miss" || res.Header.Get("X-Boson-Width") != "40" || res.Header.Get("X-Boson-Height") != "30" {
		t.Fatalf("first headers: %v", res.Header)
	}
	if res.Header.Get("Content-Type") != "image/png" || res.Header.Get("Cache-Control") != "no-cache" || res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("served headers: %v", res.Header)
	}
	res, got = fetchImage(t, app, "web", srv.URL+"/img/a.png")
	if res.Header.Get("X-Boson-Cache") != "hit" || !bytes.Equal(got, body) {
		t.Fatalf("second: %s", res.Header.Get("X-Boson-Cache"))
	}
	// The webview's revalidation of what it holds: a 304, no body.
	req, _ := http.NewRequest(http.MethodGet, app.URL+imageRoute+"?"+url.Values{"k": {"web"}, "u": {srv.URL + "/img/a.png"}}.Encode(), nil)
	req.Header.Set("If-None-Match", res.Header.Get("ETag"))
	if r304, err := http.DefaultClient.Do(req); err != nil || r304.StatusCode != http.StatusNotModified {
		t.Fatalf("If-None-Match: %v %v", r304, err)
	}
	if hits, _ := host.count("/img/a.png"); hits != 1 {
		t.Fatalf("host hit %d times, want 1", hits)
	}
}

func TestImageCacheRevalidatesWhenStale(t *testing.T) {
	host, srv := newImageHost(t)
	body := testPNG(t, 8, 8, 2)
	host.set("/img/e.png", body, map[string]string{"Cache-Control": "max-age=60", "ETag": `"v1"`})
	c, clock := newTestCache(t, t.TempDir(), 50)
	app := serveCache(t, c)
	raw := srv.URL + "/img/e.png"

	fetchImage(t, app, "web", raw)
	clock.add(30 * time.Second)
	if res, _ := fetchImage(t, app, "web", raw); res.Header.Get("X-Boson-Cache") != "hit" {
		t.Fatalf("within max-age: %s", res.Header.Get("X-Boson-Cache"))
	}
	clock.add(time.Minute)
	res, got := fetchImage(t, app, "web", raw)
	if res.Header.Get("X-Boson-Cache") != "revalidated" || !bytes.Equal(got, body) {
		t.Fatalf("stale: %s", res.Header.Get("X-Boson-Cache"))
	}
	hits, cond := host.count("/img/e.png")
	if hits != 2 || cond != 1 {
		t.Fatalf("hits %d cond %d, want 2 / 1", hits, cond)
	}
	// The 304 renewed it.
	if res, _ := fetchImage(t, app, "web", raw); res.Header.Get("X-Boson-Cache") != "hit" {
		t.Fatalf("after 304: %s", res.Header.Get("X-Boson-Cache"))
	}

	// A changed image (new ETag) replaces the old one.
	clock.add(2 * time.Minute)
	body2 := testPNG(t, 9, 9, 3)
	host.set("/img/e.png", body2, map[string]string{"Cache-Control": "max-age=60", "ETag": `"v2"`})
	res, got = fetchImage(t, app, "web", raw)
	if !bytes.Equal(got, body2) || res.Header.Get("X-Boson-Width") != "9" {
		t.Fatalf("changed: %s %s", res.Header.Get("X-Boson-Cache"), res.Header.Get("X-Boson-Width"))
	}
}

func TestImageCacheNoCacheNoStoreAndStaleOnError(t *testing.T) {
	host, srv := newImageHost(t)
	body := testPNG(t, 8, 8, 4)
	host.set("/img/nc.png", body, map[string]string{"Cache-Control": "no-cache", "ETag": `"nc"`})
	host.set("/img/ns.png", body, map[string]string{"Cache-Control": "no-store"})
	host.set("/img/mr.png", body, map[string]string{"Cache-Control": "max-age=1, must-revalidate"})
	host.set("/img/ok.png", body, map[string]string{"Cache-Control": "max-age=1"})
	c, clock := newTestCache(t, t.TempDir(), 50)
	app := serveCache(t, c)

	fetchImage(t, app, "web", srv.URL+"/img/nc.png")
	if res, _ := fetchImage(t, app, "web", srv.URL+"/img/nc.png"); res.Header.Get("X-Boson-Cache") != "revalidated" {
		t.Fatalf("no-cache: %s", res.Header.Get("X-Boson-Cache"))
	}
	fetchImage(t, app, "web", srv.URL+"/img/ns.png")
	if res, _ := fetchImage(t, app, "web", srv.URL+"/img/ns.png"); res.Header.Get("X-Boson-Cache") != "bypass" {
		t.Fatalf("no-store: %s", res.Header.Get("X-Boson-Cache"))
	}
	if _, _, n := c.store.stats(); n != 1 { // no-cache is stored, no-store isn't
		t.Fatalf("entries %d", n)
	}

	fetchImage(t, app, "web", srv.URL+"/img/mr.png")
	fetchImage(t, app, "web", srv.URL+"/img/ok.png")
	clock.add(time.Hour)
	host.down.Store(true)
	if res, got := fetchImage(t, app, "web", srv.URL+"/img/ok.png"); res.Header.Get("X-Boson-Cache") != "stale" || !bytes.Equal(got, body) {
		t.Fatalf("host down: %d %s", res.StatusCode, res.Header.Get("X-Boson-Cache"))
	}
	if res, _ := fetchImage(t, app, "web", srv.URL+"/img/mr.png"); res.StatusCode == 200 {
		t.Fatal("must-revalidate served stale")
	}
}

func TestImageCacheLRUEvictionAndContentAddressing(t *testing.T) {
	host, srv := newImageHost(t)
	// A 350 KB cap; images of ~75 KB.
	c, _ := newTestCache(t, t.TempDir(), 1)
	c.store.setLimit(350 << 10)
	app := serveCache(t, c)
	imgs := map[string][]byte{}
	for i := 0; i < 6; i++ {
		p := fmt.Sprintf("/img/%d.png", i)
		imgs[p] = testPNG(t, 180, 140, uint32(i+10)) // ~100 KB of noise
		host.set(p, imgs[p], map[string]string{"Cache-Control": "max-age=3600"})
	}
	// The same bytes under a second URL: one body on disk.
	host.set("/img/0-copy.png", imgs["/img/0.png"], map[string]string{"Cache-Control": "max-age=3600"})
	fetchImage(t, app, "web", srv.URL+"/img/0.png")
	fetchImage(t, app, "web", srv.URL+"/img/0-copy.png")
	used, _, n := c.store.stats()
	if n != 2 || used != int64(len(imgs["/img/0.png"])) {
		t.Fatalf("dedupe: %d entries, %d bytes (body %d)", n, used, len(imgs["/img/0.png"]))
	}
	for i := 1; i < 6; i++ {
		fetchImage(t, app, "web", srv.URL+fmt.Sprintf("/img/%d.png", i))
		// Keep 1 recently used.
		fetchImage(t, app, "web", srv.URL+"/img/1.png")
	}
	used, limit, _ := c.store.stats()
	if used > limit {
		t.Fatalf("over the cap: %d > %d", used, limit)
	}
	if _, ok := c.store.peek(imageKey("web", srv.URL+"/img/0.png")); ok {
		t.Fatal("least recently used survived")
	}
	if _, ok := c.store.peek(imageKey("web", srv.URL+"/img/1.png")); !ok {
		t.Fatal("recently used was evicted")
	}
	// Evicted bodies are gone from disk too.
	files := 0
	_ = filepath.Walk(filepath.Join(c.store.dir, "blobs"), func(_ string, fi os.FileInfo, _ error) error {
		if fi != nil && fi.Mode().IsRegular() {
			files++
		}
		return nil
	})
	if _, _, n := c.store.stats(); files != len(c.store.blobs) || n < files {
		t.Fatalf("%d files on disk, %d bodies, %d entries", files, len(c.store.blobs), n)
	}
}

func TestImageCachePersistsAcrossRestart(t *testing.T) {
	host, srv := newImageHost(t)
	body := testPNG(t, 20, 10, 5)
	host.set("/img/p.png", body, map[string]string{"Cache-Control": "max-age=3600"})
	dir := t.TempDir()
	c, _ := newTestCache(t, dir, 50)
	app := serveCache(t, c)
	fetchImage(t, app, "web", srv.URL+"/img/p.png")
	// A stray body no entry names (a crash mid-put) is cleaned up.
	stray := filepath.Join(dir, "blobs", "ab", strings.Repeat("ab", 32))
	_ = os.MkdirAll(filepath.Dir(stray), 0o700)
	_ = os.WriteFile(stray, []byte("x"), 0o600)
	if err := c.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}

	c2, _ := newTestCache(t, dir, 50)
	app2 := serveCache(t, c2)
	res, got := fetchImage(t, app2, "web", srv.URL+"/img/p.png")
	if res.Header.Get("X-Boson-Cache") != "hit" || !bytes.Equal(got, body) || res.Header.Get("X-Boson-Width") != "20" {
		t.Fatalf("after restart: %s", res.Header.Get("X-Boson-Cache"))
	}
	if hits, _ := host.count("/img/p.png"); hits != 1 {
		t.Fatalf("host hit %d times", hits)
	}
	if _, err := os.Stat(stray); !os.IsNotExist(err) {
		t.Fatal("stray body kept")
	}
	// Clear empties it.
	if st := c2.Clear(); st.Entries != 0 || st.UsedBytes != 0 {
		t.Fatalf("clear: %+v", st)
	}
	// SetLimitMB is remembered.
	c2.SetLimitMB(128)
	t.Setenv("BOSON_IMAGE_CACHE_MB", "")
	c3 := NewImageCacheService(dir, filepath.Join(dir, "settings.json"), true)
	if _, limit, _ := c3.store.stats(); limit != 128<<20 {
		t.Fatalf("limit %d", limit)
	}
}

func TestImageCacheThumbnails(t *testing.T) {
	host, srv := newImageHost(t)
	big := testPNG(t, 1600, 1000, 6)
	host.set("/img/big.png", big, map[string]string{"Cache-Control": "max-age=3600"})
	small := testPNG(t, 100, 50, 7)
	host.set("/img/small.png", small, map[string]string{"Cache-Control": "max-age=3600"})
	c, _ := newTestCache(t, t.TempDir(), 100)
	app := serveCache(t, c)

	res, got := fetchImage(t, app, "web", srv.URL+"/img/big.png", 640, 280)
	if res.StatusCode != 200 {
		t.Fatalf("thumb: %d", res.StatusCode)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(got))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != 448 || cfg.Height != 280 || res.Header.Get("X-Boson-Width") != "448" || res.Header.Get("X-Boson-Orig-Width") != "1600" {
		t.Fatalf("thumb %dx%d, headers %v", cfg.Width, cfg.Height, res.Header)
	}
	if len(got) >= len(big)/4 {
		t.Fatalf("thumb is %d bytes of %d", len(got), len(big))
	}
	if res.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("opaque thumb type %s", res.Header.Get("Content-Type"))
	}
	// The full image (the lightbox) comes from the cache too.
	res, got = fetchImage(t, app, "web", srv.URL+"/img/big.png")
	if res.Header.Get("X-Boson-Cache") != "hit" || !bytes.Equal(got, big) {
		t.Fatalf("full: %s", res.Header.Get("X-Boson-Cache"))
	}
	// And the thumbnail again, without re-scaling (stored).
	if _, ok := c.store.peek(thumbKey("web", srv.URL+"/img/big.png", 640, 280)); !ok {
		t.Fatal("thumbnail not stored")
	}
	if hits, _ := host.count("/img/big.png"); hits != 1 {
		t.Fatalf("host hit %d times", hits)
	}
	// A small image is served as it is.
	res, got = fetchImage(t, app, "web", srv.URL+"/img/small.png", 640, 280)
	if !bytes.Equal(got, small) || res.Header.Get("X-Boson-Width") != "100" {
		t.Fatalf("small: %v", res.Header)
	}
}

func TestImageCacheTransparentThumbIsPNG(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 900, 900))
	for i := range img.Pix {
		img.Pix[i] = byte(i * 7)
	}
	img.Set(0, 0, color.NRGBA{0, 0, 0, 0})
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	out, ct, w, h, err := makeThumb(b.Bytes(), 300, 0)
	if err != nil || ct != "image/png" || w != 300 || h != 300 || len(out) == 0 {
		t.Fatalf("%s %dx%d %v", ct, w, h, err)
	}
}

func TestImageCacheRefusals(t *testing.T) {
	host, srv := newImageHost(t)
	host.set("/page.html", []byte("<html><body>not an image</body></html>"), nil)
	c, _ := newTestCache(t, t.TempDir(), 50)
	app := serveCache(t, c)
	if res, _ := fetchImage(t, app, "web", srv.URL+"/page.html"); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("html: %d", res.StatusCode)
	}
	if res, _ := fetchImage(t, app, "web", srv.URL+"/missing.png"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("missing: %d", res.StatusCode)
	}
	if res, _ := fetchImage(t, app, "web", "file:///etc/passwd"); res.StatusCode != http.StatusForbidden {
		t.Fatalf("file url: %d", res.StatusCode)
	}
	if res, _ := fetchImage(t, app, "nope", srv.URL+"/x.png"); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown kind: %d", res.StatusCode)
	}
	// Without a branding/files service, those kinds don't exist.
	if res, _ := fetchImage(t, app, "file", srv.URL+"/f/x/y.png"); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("no files: %d", res.StatusCode)
	}

	// A release build never reaches a private address, even by name.
	t.Setenv("BOSON_IMAGE_CACHE_MB", "50")
	prod := NewImageCacheService(t.TempDir(), "", false)
	prodApp := serveCache(t, prod)
	if res, _ := fetchImage(t, prodApp, "web", srv.URL+"/img/a.png"); res.StatusCode != http.StatusForbidden {
		t.Fatalf("loopback in a release build: %d", res.StatusCode)
	}
	if res, _ := fetchImage(t, prodApp, "web", "https://192.168.1.10/a.png"); res.StatusCode != http.StatusForbidden {
		t.Fatalf("private address: %d", res.StatusCode)
	}
}

func TestImageCacheCoalescesConcurrentFetches(t *testing.T) {
	var hits atomic.Int32
	body := testPNG(t, 16, 16, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		time.Sleep(100 * time.Millisecond)
		w.Header().Set("Cache-Control", "max-age=3600")
		_, _ = w.Write(body)
	}))
	defer srv.Close()
	c, _ := newTestCache(t, t.TempDir(), 50)
	app := serveCache(t, c)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, got := fetchImage(t, app, "web", srv.URL+"/c.png")
			if res.StatusCode != 200 || !bytes.Equal(got, body) {
				t.Errorf("got %d", res.StatusCode)
			}
		}()
	}
	wg.Wait()
	if hits.Load() != 1 {
		t.Fatalf("%d fetches, want 1", hits.Load())
	}
}

func TestImageCacheFilesExpireAtXFileExpiresAt(t *testing.T) {
	files, filesHost := newTestFiles(t, nil)
	if _, err := files.trust(filesHost.URL); err != nil {
		t.Fatal(err)
	}
	c, clock := newTestCache(t, t.TempDir(), 50)
	c.useFiles(files)
	app := serveCache(t, c)
	// (fakeFilesHost's files aren't images; serve a real one.)
	body := testPNG(t, 12, 12, 9)
	expires := clock.now().Add(48 * time.Hour)
	fh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/f/gone/") {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=999999")
		w.Header().Set("ETag", `"abc"`)
		w.Header().Set("X-File-Expires-At", expires.Format(time.RFC3339))
		w.Header().Set("X-File-Content-Type", "image/png")
		_, _ = w.Write(body)
	}))
	defer fh.Close()
	if _, err := files.trust(fh.URL); err != nil {
		t.Fatal(err)
	}
	raw := fh.URL + "/f/abcdefghijklmnopqrstuvwxyz/x.png"
	res, got := fetchImage(t, app, "file", raw)
	if res.StatusCode != 200 || !bytes.Equal(got, body) || res.Header.Get("X-File-Expires-At") == "" || res.Header.Get("X-File-Content-Type") != "image/png" {
		t.Fatalf("file: %d %v", res.StatusCode, res.Header)
	}
	if res, _ := fetchImage(t, app, "file", raw); res.Header.Get("X-Boson-Cache") != "hit" {
		t.Fatal("not cached")
	}
	// Past its expiry it's dropped, even though max-age said otherwise.
	clock.add(49 * time.Hour)
	if _, ok := c.store.peek(imageKey("file", raw)); !ok {
		t.Fatal("entry gone too early")
	}
	res, _ = fetchImage(t, app, "file", raw)
	if res.Header.Get("X-Boson-Cache") != "miss" {
		t.Fatalf("after expiry: %s", res.Header.Get("X-Boson-Cache"))
	}
	if res, _ := fetchImage(t, app, "file", fh.URL+"/f/gone/x.png"); res.StatusCode != http.StatusGone {
		t.Fatalf("gone: %d", res.StatusCode)
	}
	// Only files hosts' /f/ URLs.
	if res, _ := fetchImage(t, app, "file", fh.URL+"/v1/config"); res.StatusCode != http.StatusForbidden {
		t.Fatalf("not /f/: %d", res.StatusCode)
	}
}

func TestImageCacheThemeKindUsesBrandingRules(t *testing.T) {
	host, srv := newImageHost(t)
	host.set("/logo.png", testPNG(t, 64, 64, 11), map[string]string{"Cache-Control": "max-age=3600"})
	host.set("/huge.png", testPNG(t, 5000, 10, 12), map[string]string{"Cache-Control": "max-age=3600"})
	c, _ := newTestCache(t, t.TempDir(), 50)
	c.useBranding(NewBrandingService(true))
	app := serveCache(t, c)
	if res, _ := fetchImage(t, app, "theme", srv.URL+"/logo.png"); res.StatusCode != 200 {
		t.Fatalf("logo: %d", res.StatusCode)
	}
	if res, _ := fetchImage(t, app, "theme", srv.URL+"/huge.png"); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("5000 px wide: %d", res.StatusCode)
	}
}

func TestFreshness(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i+1 < len(kv); i += 2 {
			out.Set(kv[i], kv[i+1])
		}
		return out
	}
	cases := []struct {
		name string
		h    http.Header
		ttl  time.Duration
	}{
		{"max-age", h("Cache-Control", "public, max-age=120"), 2 * time.Minute},
		{"max-age minus Age", h("Cache-Control", "max-age=120", "Age", "20"), 100 * time.Second},
		{"expires", h("Date", now.Add(-time.Minute).Format(http.TimeFormat), "Expires", now.Add(time.Hour).Format(http.TimeFormat)), 61 * time.Minute},
		{"last-modified heuristic", h("Last-Modified", now.Add(-100*time.Hour).Format(http.TimeFormat)), 10 * time.Hour},
		{"heuristic capped", h("Last-Modified", now.Add(-10000*time.Hour).Format(http.TimeFormat)), imageHeuristicMax},
		{"nothing", h(), imageDefaultTTL},
		{"immutable", h("Cache-Control", "immutable"), imageHeuristicMax},
	}
	for _, tc := range cases {
		f := freshness(tc.h, now)
		if got := f.expires.Sub(now); got != tc.ttl {
			t.Errorf("%s: ttl %v, want %v", tc.name, got, tc.ttl)
		}
	}
	if f := freshness(h("Cache-Control", "no-store, no-cache, must-revalidate"), now); !f.noStore || !f.noCache || !f.mustRevalidate {
		t.Errorf("flags: %+v", f)
	}
}

func TestFitBox(t *testing.T) {
	for _, tc := range []struct{ w, h, bw, bh, tw, th int }{
		{1600, 1000, 640, 280, 448, 280},
		{1600, 1000, 640, 0, 640, 400},
		{100, 50, 640, 280, 100, 50},
		{4000, 10, 100, 100, 100, 1},
	} {
		if tw, th := fitBox(tc.w, tc.h, tc.bw, tc.bh); tw != tc.tw || th != tc.th {
			t.Errorf("fitBox(%d,%d,%d,%d) = %d,%d want %d,%d", tc.w, tc.h, tc.bw, tc.bh, tw, th, tc.tw, tc.th)
		}
	}
}
