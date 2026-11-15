package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // thumbnails of WebP images
)

// ImageCacheService: the app's one image cache, on disk, shared by every
// way an image reaches the renderer — link embeds and their preview cards,
// avatars, network theme images and uploaded files' previews. The renderer
// asks for an image at /_boson/img?k=<kind>&u=<url> on the app's own origin
// (so the page's CSP needn't name any image host) and gets it from disk
// when it's fresh, after a conditional request when it's stale (ETag /
// Last-Modified; 304 keeps the body), or from the network.
//
//   - Freshness follows the answer's Cache-Control (max-age, no-cache,
//     no-store, must-revalidate) and Expires, else a heuristic from
//     Last-Modified (10% of its age, at most a week), else an hour.
//   - Uploaded files (k=file) also stop at their X-File-Expires-At: never
//     served after it, revalidated or not.
//   - A stale entry whose host can't be reached is served as it is (unless
//     the answer said must-revalidate).
//   - &w=&h= asks for an inline thumbnail: a big image is scaled down to fit
//     that box once, stored as its own entry next to the original (which the
//     lightbox asks for, without w/h). Animated GIFs and SVGs aren't scaled.
//   - Every answer says how big the image is (X-Boson-Width / -Height, the
//     original's in X-Boson-Orig-Width / -Height), so the renderer can
//     reserve its box before the next render.
//
// Bodies are content-addressed (imageStore): the same bytes under several
// URLs are kept once. The cap (500 MB by default; SetLimitMB, or
// BOSON_IMAGE_CACHE_MB) is enforced least recently used first.
//
// Which hosts each kind may reach: k=web (embeds, cards, avatars) any
// public http(s) host, never a private address (checked on every
// connection, like the unfurler); k=theme the branding service's rules
// (desktop/branding.go: https, 2 MB, 4096 px a side); k=file only the
// allowed files hosts' /f/ URLs (desktop/files.go). Dev builds may also
// reach loopback (the e2e servers).
type ImageCacheService struct {
	store    *imageStore
	storeErr error
	dev      bool
	now      func() time.Time
	sources  map[string]imageSource
	settings string // where the cap is remembered

	flightMu sync.Mutex
	flight   map[string]*imageCall
}

// imageSource is one kind of image: which URLs it may fetch and how.
type imageSource struct {
	// check validates the URL ("" OK); a refusal answers 403.
	check  func(u *url.URL) error
	client *http.Client
	ua     string
	accept string
	// maxBytes: the most this kind's body may be (also bounded by the
	// cache's own per-entry share).
	maxBytes int64
	// validate checks the body (beyond being an image), e.g. a theme
	// image's size.
	validate func(body []byte) error
	// files: uploaded files (X-File-Expires-At is a hard expiry; their
	// meta headers are passed on).
	files bool
}

type imageCall struct {
	done chan struct{}
	res  *imageResult
	err  error
}

// imageResult is what an answer serves: a stored entry (its body on disk),
// or the bytes in memory (not cacheable, or evicted at once).
type imageResult struct {
	entry  imageEntry
	body   []byte // when not served from disk
	cache  string // hit | miss | revalidated | stale | bypass
	status int    // the upstream's error status (404, 410, …) when no body
}

const (
	imageRoute          = "/_boson/img"
	defaultImageCacheMB = 500
	imageWebMaxBytes    = 25 << 20
	imageFetchTimeout   = 20 * time.Second
	imageDefaultTTL     = time.Hour
	imageHeuristicMax   = 7 * 24 * time.Hour
	// Thumbnails: only for originals bigger than this or over the box by
	// more than a quarter; at most this many pixels decoded.
	imageThumbMinBytes = 200 << 10
	imageThumbMaxPix   = 50_000_000
	imageThumbMaxBox   = 4096
)

// ImageCacheStats is what Settings shows.
type ImageCacheStats struct {
	UsedBytes  int64  `json:"usedBytes"`
	LimitBytes int64  `json:"limitBytes"`
	Entries    int    `json:"entries"`
	Error      string `json:"error,omitempty"`
}

// NewImageCacheService opens the cache in dir (created when missing). The
// sources are added by the services that own their rules (useBranding,
// useFiles); the web kind is built in.
func NewImageCacheService(dir, settingsFile string, dev bool) *ImageCacheService {
	c := &ImageCacheService{
		dev: dev, now: time.Now, settings: settingsFile,
		sources: map[string]imageSource{}, flight: map[string]*imageCall{},
	}
	limit := int64(defaultImageCacheMB) << 20
	if mb := c.savedLimitMB(); mb > 0 {
		limit = int64(mb) << 20
	}
	if v, err := strconv.Atoi(os.Getenv("BOSON_IMAGE_CACHE_MB")); err == nil && v > 0 {
		limit = int64(v) << 20
	}
	c.store, c.storeErr = openImageStore(dir, limit, func() time.Time { return c.now() })
	if c.storeErr != nil {
		log.Printf("image cache: %v (images load without it)", c.storeErr)
	}
	c.sources["web"] = c.webSource()
	return c
}

// imageCacheDir: <user cache dir>/Boson/images; dev builds with
// BOSON_DATA_DIR (a test profile) keep it under that.
func imageCacheDir(dataDir string) string {
	if devBuild == "true" && os.Getenv("BOSON_DATA_DIR") != "" {
		return filepath.Join(dataDir, "cache", "images")
	}
	if base, err := os.UserCacheDir(); err == nil && base != "" {
		return filepath.Join(base, "Boson", "images")
	}
	return filepath.Join(dataDir, "cache", "images")
}

// ServiceShutdown saves the index.
func (c *ImageCacheService) ServiceShutdown() error {
	if c.store != nil {
		return c.store.close()
	}
	return nil
}

// ---- bindings (Settings → Storage) ----

func (c *ImageCacheService) Stats() ImageCacheStats {
	if c.store == nil {
		return ImageCacheStats{Error: errString(c.storeErr)}
	}
	used, limit, n := c.store.stats()
	return ImageCacheStats{UsedBytes: used, LimitBytes: limit, Entries: n}
}

// SetLimitMB changes the cap (64 MB … 10 GB) and remembers it.
func (c *ImageCacheService) SetLimitMB(mb int) ImageCacheStats {
	if mb < 64 {
		mb = 64
	}
	if mb > 10<<10 {
		mb = 10 << 10
	}
	if c.store != nil {
		c.store.setLimit(int64(mb) << 20)
	}
	if c.settings != "" {
		b, _ := json.Marshal(map[string]int{"limitMB": mb})
		_ = os.WriteFile(c.settings, b, 0o600)
	}
	return c.Stats()
}

// Clear empties the cache.
func (c *ImageCacheService) Clear() ImageCacheStats {
	if c.store != nil {
		c.store.clear()
		_ = c.store.flush()
	}
	return c.Stats()
}

func (c *ImageCacheService) savedLimitMB() int {
	if c.settings == "" {
		return 0
	}
	b, err := os.ReadFile(c.settings)
	if err != nil {
		return 0
	}
	var v struct {
		LimitMB int `json:"limitMB"`
	}
	_ = json.Unmarshal(b, &v)
	return v.LimitMB
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// ---- sources ----

// webSource: link embeds, preview-card images and avatars. Any public
// http(s) host; every connection is checked against private addresses.
func (c *ImageCacheService) webSource() imageSource {
	hostMap := map[string]string{}
	if c.dev {
		for _, kv := range strings.Split(os.Getenv("BOSON_E2E_HOST_MAP"), ",") {
			name, ip, ok := strings.Cut(strings.TrimSpace(kv), "=")
			if ok && name != "" && ip != "" {
				hostMap[strings.ToLower(name)] = ip
			}
		}
	}
	dev := c.dev
	transport := guardedTransport(dev, hostMap, imageFetchTimeout)
	client := &http.Client{
		Timeout:   imageFetchTimeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			return checkWebImageURL(req.URL, dev, hostMap)
		},
	}
	return imageSource{
		check:    func(u *url.URL) error { return checkWebImageURL(u, dev, hostMap) },
		client:   client,
		ua:       browserUA,
		accept:   "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8",
		maxBytes: imageWebMaxBytes,
	}
}

func checkWebImageURL(u *url.URL, dev bool, hostMap map[string]string) error {
	if u == nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return errors.New("not an http(s) URL")
	}
	host := strings.ToLower(u.Hostname())
	if _, ok := hostMap[host]; ok {
		return nil
	}
	if dev && isLoopback(u) {
		return nil
	}
	if isBlockedHost(host) {
		return errBlockedAddr
	}
	return nil
}

// guardedTransport refuses private addresses on every connection (dev
// builds: loopback allowed; hostMap names dial the mapped address).
func guardedTransport(dev bool, hostMap map[string]string, timeout time.Duration) *http.Transport {
	dialer := &net.Dialer{Timeout: timeout}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if ip, ok := hostMap[strings.ToLower(host)]; ok {
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
		}
		d := *dialer
		d.Control = func(_, address string, _ syscall.RawConn) error {
			h, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(h)
			if ip == nil {
				return errBlockedAddr
			}
			if dev && ip.IsLoopback() {
				return nil
			}
			if isBlockedIP(ip) {
				return errBlockedAddr
			}
			return nil
		}
		return d.DialContext(ctx, network, addr)
	}
	return t
}

// useBranding: k=theme follows the branding service's rules.
func (c *ImageCacheService) useBranding(b *BrandingService) {
	if b == nil {
		return
	}
	c.sources["theme"] = imageSource{
		check:    b.checkURL,
		client:   b.client,
		ua:       "Boson",
		accept:   "image/png,image/jpeg,image/webp,image/gif,image/svg+xml",
		maxBytes: brandingImageMax,
		validate: func(body []byte) error { _, err := checkBrandingImage(body); return err },
	}
}

// useFiles: k=file is an uploaded file's preview, from an allowed files
// host only.
func (c *ImageCacheService) useFiles(f *FilesService) {
	if f == nil {
		return
	}
	c.sources["file"] = imageSource{
		check: func(u *url.URL) error {
			base, _, ok := f.trustedBase(u.String())
			if !ok || !strings.HasPrefix(u.EscapedPath(), mustPath(base)+"/f/") {
				return errors.New("not a file on a files host")
			}
			return nil
		},
		client:   f.stream,
		ua:       "Boson",
		accept:   "image/*",
		maxBytes: imageWebMaxBytes,
		files:    true,
	}
}

// ---- the route ----

// ServeHTTP answers GET /_boson/img?k=<kind>&u=<url>[&w=<px>&h=<px>].
func (c *ImageCacheService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	kind := q.Get("k")
	if kind == "" {
		kind = "web"
	}
	src, ok := c.sources[kind]
	if !ok {
		imageError(w, http.StatusBadRequest, "unknown kind")
		return
	}
	raw := q.Get("u")
	if len(raw) > 4096 {
		imageError(w, http.StatusBadRequest, "url too long")
		return
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		imageError(w, http.StatusBadRequest, "bad url")
		return
	}
	u.Fragment = ""
	if err := src.check(u); err != nil {
		imageError(w, http.StatusForbidden, err.Error())
		return
	}
	bw, _ := strconv.Atoi(q.Get("w"))
	bh, _ := strconv.Atoi(q.Get("h"))
	res, err := c.get(r.Context(), kind, src, u.String(), clampBox(bw), clampBox(bh))
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errNotImage) {
			status = http.StatusUnsupportedMediaType
		} else if errors.Is(err, errTooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		imageError(w, status, err.Error())
		return
	}
	if res.status != 0 {
		imageError(w, res.status, http.StatusText(res.status))
		return
	}
	c.write(w, r, res)
}

func clampBox(n int) int {
	if n <= 0 {
		return 0
	}
	if n > imageThumbMaxBox {
		return imageThumbMaxBox
	}
	return n
}

func imageError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Boson-Error", strings.ReplaceAll(msg, "\n", " "))
	http.Error(w, msg, status)
}

func (c *ImageCacheService) write(w http.ResponseWriter, r *http.Request, res *imageResult) {
	e := res.entry
	h := w.Header()
	h.Set("Content-Type", e.Type)
	// The page shows images straight from this route (no copy in the JS
	// heap). The webview may keep one, but asks again each time (cheap: a
	// 304 against the body's hash), so what it shows follows this cache.
	h.Set("Cache-Control", "no-cache")
	if e.Blob != "" && res.body == nil {
		h.Set("ETag", `"`+e.Blob+`"`)
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	h.Set("X-Boson-Cache", res.cache)
	if e.Width > 0 && e.Height > 0 {
		h.Set("X-Boson-Width", strconv.Itoa(e.Width))
		h.Set("X-Boson-Height", strconv.Itoa(e.Height))
	}
	if e.OrigWidth > 0 && e.OrigHeight > 0 {
		h.Set("X-Boson-Orig-Width", strconv.Itoa(e.OrigWidth))
		h.Set("X-Boson-Orig-Height", strconv.Itoa(e.OrigHeight))
	}
	for k, v := range e.Meta {
		h.Set(k, v)
	}
	if res.body != nil {
		h.Set("Content-Length", strconv.Itoa(len(res.body)))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write(res.body)
		}
		return
	}
	f, err := c.store.open(e)
	if err != nil {
		// Evicted between lookup and open: fetch it again next time.
		imageError(w, http.StatusServiceUnavailable, "evicted, retry")
		return
	}
	defer f.Close()
	http.ServeContent(w, r, "", time.Time{}, f)
}

// ---- lookup ----

var errNotImage = errors.New("not an image")

func imageKey(kind, raw string) string { return kind + " " + raw }

func thumbKey(kind, raw string, w, h int) string {
	return fmt.Sprintf("%s %s #thumb=%dx%d", kind, raw, w, h)
}

// get: the image (or its thumbnail when a box is given), coalescing
// concurrent requests for the same thing.
func (c *ImageCacheService) get(ctx context.Context, kind string, src imageSource, raw string, bw, bh int) (*imageResult, error) {
	key := imageKey(kind, raw)
	if bw > 0 || bh > 0 {
		key = thumbKey(kind, raw, bw, bh)
	}
	c.flightMu.Lock()
	if call := c.flight[key]; call != nil {
		c.flightMu.Unlock()
		select {
		case <-call.done:
			return call.res, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &imageCall{done: make(chan struct{})}
	c.flight[key] = call
	c.flightMu.Unlock()
	// Not the asker's context: others may be waiting on this fetch, and a
	// fetched image is worth storing even if this view went away.
	fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), imageFetchTimeout+5*time.Second)
	defer cancel()
	call.res, call.err = c.lookup(fctx, kind, src, raw, bw, bh)
	c.flightMu.Lock()
	delete(c.flight, key)
	c.flightMu.Unlock()
	close(call.done)
	return call.res, call.err
}

func (c *ImageCacheService) lookup(ctx context.Context, kind string, src imageSource, raw string, bw, bh int) (*imageResult, error) {
	orig, err := c.resolve(ctx, kind, src, raw)
	if err != nil || orig.status != 0 || (bw == 0 && bh == 0) {
		return orig, err
	}
	if !thumbWorthIt(orig.entry, bw, bh) {
		return orig, nil
	}
	tk := thumbKey(kind, raw, bw, bh)
	if c.store != nil {
		if t, ok := c.store.get(tk); ok && t.Source == orig.entry.Blob && !c.hardExpired(t) {
			return &imageResult{entry: t, cache: orig.cache}, nil
		}
	}
	body := orig.body
	if body == nil {
		body, err = c.store.read(orig.entry)
		if err != nil {
			return orig, nil
		}
	}
	thumb, ct, tw, th, err := makeThumb(body, bw, bh)
	if err != nil || len(thumb) >= len(body) {
		return orig, nil
	}
	te := orig.entry
	te.Key, te.Type, te.Width, te.Height = tk, ct, tw, th
	te.OrigWidth, te.OrigHeight, te.Source = orig.entry.Width, orig.entry.Height, orig.entry.Blob
	if c.store != nil && orig.body == nil {
		if stored, err := c.store.put(te, thumb); err == nil {
			if _, still := c.store.peek(tk); still {
				return &imageResult{entry: stored, cache: orig.cache}, nil
			}
		}
	}
	te.Blob = ""
	return &imageResult{entry: te, body: thumb, cache: orig.cache}, nil
}

// thumbWorthIt: a stored raster image bigger than the box (by a quarter,
// in either side) and heavy enough to matter.
func thumbWorthIt(e imageEntry, bw, bh int) bool {
	switch e.Type {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		return false
	}
	if e.Width <= 0 || e.Height <= 0 || e.Width*e.Height > imageThumbMaxPix {
		return false
	}
	if e.Size < imageThumbMinBytes {
		return false
	}
	over := (bw > 0 && e.Width*4 > bw*5) || (bh > 0 && e.Height*4 > bh*5)
	return over
}

func (c *ImageCacheService) hardExpired(e imageEntry) bool {
	return !e.HardExpiry.IsZero() && !c.now().Before(e.HardExpiry)
}

// resolve: the original image, from disk when fresh, revalidated when
// stale, else fetched.
func (c *ImageCacheService) resolve(ctx context.Context, kind string, src imageSource, raw string) (*imageResult, error) {
	key := imageKey(kind, raw)
	var have *imageEntry
	if c.store != nil {
		if e, ok := c.store.get(key); ok {
			if c.hardExpired(e) {
				c.store.remove(key)
			} else {
				have = &e
			}
		}
	}
	if have != nil && !have.NoCache && c.now().Before(have.Expires) {
		return &imageResult{entry: *have, cache: "hit"}, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", src.ua)
	req.Header.Set("Accept", src.accept)
	if have != nil {
		if have.ETag != "" {
			req.Header.Set("If-None-Match", have.ETag)
		}
		if have.LastModified != "" {
			req.Header.Set("If-Modified-Since", have.LastModified)
		}
	}
	res, err := src.client.Do(req)
	if err != nil {
		if have != nil && !have.MustReval {
			return &imageResult{entry: *have, cache: "stale"}, nil
		}
		return nil, err
	}
	defer res.Body.Close()
	now := c.now()
	if res.StatusCode == http.StatusNotModified && have != nil {
		fresh := freshness(res.Header, now)
		e, ok := c.store.update(key, func(e *imageEntry) {
			e.Expires, e.NoCache, e.MustReval = fresh.expires, fresh.noCache, fresh.mustRevalidate
			if v := res.Header.Get("ETag"); v != "" {
				e.ETag = v
			}
			if src.files {
				if at := filesHardExpiry(res.Header); !at.IsZero() {
					e.HardExpiry = at
				}
			}
		})
		if !ok {
			e = *have
		}
		return &imageResult{entry: e, cache: "revalidated"}, nil
	}
	if res.StatusCode != http.StatusOK {
		if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
			if c.store != nil {
				c.store.remove(key)
			}
			return &imageResult{status: res.StatusCode}, nil
		}
		if have != nil && !have.MustReval && res.StatusCode >= 500 {
			return &imageResult{entry: *have, cache: "stale"}, nil
		}
		return &imageResult{status: http.StatusBadGateway}, nil
	}
	max := src.maxBytes
	if c.store != nil {
		if m := c.store.maxEntry(); m < max {
			max = m
		}
	}
	if res.ContentLength > max {
		return nil, errTooLarge
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > max {
		return nil, errTooLarge
	}
	ct, w, h, err := sniffImage(body, res.Header.Get("Content-Type"))
	if err != nil {
		return nil, err
	}
	if src.validate != nil {
		if err := src.validate(body); err != nil {
			return nil, fmt.Errorf("%w: %v", errNotImage, err)
		}
	}
	fresh := freshness(res.Header, now)
	e := imageEntry{
		Key: key, URL: raw, Type: ct, Width: w, Height: h,
		ETag: res.Header.Get("ETag"), LastModified: res.Header.Get("Last-Modified"),
		Expires: fresh.expires, NoCache: fresh.noCache, MustReval: fresh.mustRevalidate,
	}
	if src.files {
		e.HardExpiry = filesHardExpiry(res.Header)
		e.Meta = map[string]string{}
		for _, k := range []string{"X-File-Expires-At", "X-File-Content-Type", "Last-Modified", "ETag"} {
			if v := res.Header.Get(k); v != "" {
				e.Meta[k] = v
			}
		}
	}
	if fresh.noStore || c.store == nil {
		return &imageResult{entry: e, body: body, cache: "bypass"}, nil
	}
	stored, err := c.store.put(e, body)
	if err != nil {
		return &imageResult{entry: e, body: body, cache: "bypass"}, nil
	}
	if _, still := c.store.peek(key); !still {
		return &imageResult{entry: stored, body: body, cache: "bypass"}, nil
	}
	cache := "miss"
	if have != nil {
		cache = "revalidated"
	}
	return &imageResult{entry: stored, cache: cache}, nil
}

func filesHardExpiry(h http.Header) time.Time {
	t, err := time.Parse(time.RFC3339, h.Get("X-File-Expires-At"))
	if err != nil {
		return time.Time{}
	}
	return t
}

type cacheFreshness struct {
	expires        time.Time
	noStore        bool
	noCache        bool
	mustRevalidate bool
}

// freshness: when an answer goes stale (RFC 9111, as a private cache).
func freshness(h http.Header, now time.Time) cacheFreshness {
	var f cacheFreshness
	maxAge := -1
	immutable := false
	for _, part := range strings.Split(strings.ToLower(h.Get("Cache-Control")), ",") {
		name, val, _ := strings.Cut(strings.TrimSpace(part), "=")
		val = strings.Trim(val, `"`)
		switch name {
		case "no-store":
			f.noStore = true
		case "no-cache":
			f.noCache = true
		case "must-revalidate", "proxy-revalidate":
			f.mustRevalidate = true
		case "immutable":
			immutable = true
		case "max-age":
			if n, err := strconv.Atoi(val); err == nil && n >= 0 {
				maxAge = n
			}
		}
	}
	date := now
	if d, err := http.ParseTime(h.Get("Date")); err == nil && d.Before(now) && now.Sub(d) < 24*time.Hour {
		date = d
	}
	switch {
	case maxAge >= 0:
		f.expires = now.Add(time.Duration(maxAge) * time.Second)
		if age, err := strconv.Atoi(h.Get("Age")); err == nil && age > 0 {
			f.expires = f.expires.Add(-time.Duration(age) * time.Second)
		}
	case h.Get("Expires") != "":
		if exp, err := http.ParseTime(h.Get("Expires")); err == nil {
			f.expires = now.Add(exp.Sub(date))
		} else {
			f.expires = now // invalid Expires: already stale
		}
	case h.Get("Last-Modified") != "":
		if lm, err := http.ParseTime(h.Get("Last-Modified")); err == nil && lm.Before(date) {
			ttl := date.Sub(lm) / 10
			if ttl > imageHeuristicMax {
				ttl = imageHeuristicMax
			}
			f.expires = now.Add(ttl)
		} else {
			f.expires = now.Add(imageDefaultTTL)
		}
	default:
		f.expires = now.Add(imageDefaultTTL)
	}
	if immutable && maxAge < 0 {
		f.expires = now.Add(imageHeuristicMax)
	}
	return f
}

// sniffImage: the image's type (by its bytes) and size. The declared type
// only counts for formats the sniffer doesn't know (AVIF).
func sniffImage(body []byte, declared string) (string, int, int, error) {
	if len(body) == 0 {
		return "", 0, 0, errNotImage
	}
	ct := http.DetectContentType(body)
	switch ct {
	case "image/png", "image/jpeg", "image/gif":
		cfg, _, err := image.DecodeConfig(bytes.NewReader(body))
		if err != nil {
			return "", 0, 0, fmt.Errorf("%w: unreadable %s", errNotImage, ct)
		}
		return ct, cfg.Width, cfg.Height, nil
	case "image/webp":
		w, h, err := webpSize(body)
		if err != nil {
			return "", 0, 0, fmt.Errorf("%w: %v", errNotImage, err)
		}
		return ct, w, h, nil
	case "image/bmp", "image/x-icon", "image/vnd.microsoft.icon", "image/avif":
		return ct, 0, 0, nil
	}
	if isSVG(body) {
		return "image/svg+xml", 0, 0, nil
	}
	d := strings.ToLower(strings.TrimSpace(strings.Split(declared, ";")[0]))
	if d == "image/avif" || d == "image/jxl" || d == "image/heic" {
		return d, 0, 0, nil
	}
	return "", 0, 0, fmt.Errorf("%w (%s)", errNotImage, ct)
}

// makeThumb scales body down to fit bw×bh (either may be 0: unbounded),
// as JPEG when it's opaque, else PNG. An animated GIF isn't scaled.
func makeThumb(body []byte, bw, bh int) ([]byte, string, int, int, error) {
	if http.DetectContentType(body) == "image/gif" && gifFrames(body) > 1 {
		return nil, "", 0, 0, errors.New("animated")
	}
	src, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		return nil, "", 0, 0, err
	}
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	tw, th := fitBox(sw, sh, bw, bh)
	if tw >= sw && th >= sh {
		return nil, "", 0, 0, errors.New("no smaller")
	}
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	var out bytes.Buffer
	if opaque(dst) {
		err = jpeg.Encode(&out, dst, &jpeg.Options{Quality: 85})
		return out.Bytes(), "image/jpeg", tw, th, err
	}
	err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&out, dst)
	return out.Bytes(), "image/png", tw, th, err
}

// fitBox: w×h scaled (never up) to fit bw×bh, keeping the aspect ratio.
func fitBox(w, h, bw, bh int) (int, int) {
	scale := 1.0
	if bw > 0 && w > bw {
		scale = float64(bw) / float64(w)
	}
	if bh > 0 && float64(h)*scale > float64(bh) {
		scale = float64(bh) / float64(h)
	}
	tw, th := int(float64(w)*scale+0.5), int(float64(h)*scale+0.5)
	if tw < 1 {
		tw = 1
	}
	if th < 1 {
		th = 1
	}
	return tw, th
}

func opaque(m *image.RGBA) bool {
	for i := 3; i < len(m.Pix); i += 4 {
		if m.Pix[i] != 0xff {
			return false
		}
	}
	return true
}

// gifFrames counts a GIF's image descriptors (2 is enough to know it's
// animated); 0 when unreadable.
func gifFrames(body []byte) int {
	n := 0
	// Cheap scan: image separators (0x2C) after graphic control extensions
	// (0x21 0xF9). Counting GCEs is a good enough signal for animation.
	for i := 0; i+1 < len(body); i++ {
		if body[i] == 0x21 && body[i+1] == 0xF9 {
			n++
			if n > 1 {
				return n
			}
		}
	}
	return n
}
