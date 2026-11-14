package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ApiService proxies the renderer's API requests, so they aren't subject to
// the webview's CORS: the page's origin (wails://localhost,
// http://wails.localhost) isn't one api.boson.chat allows. Go's HTTP client
// has no CORS notion. It carries the auth service's requests
// (auth.boson.chat: sign-in, refresh, …) the same way.
//
// Because it isn't subject to CORS or the page's CSP, this is a powerful
// primitive: anything that can call it can make requests from the user's
// machine. So it only reaches an exact-origin allowlist — our own API and auth service — and
// re-checks that on every redirect hop.
type ApiService struct {
	policy apiPolicy
	client *http.Client

	// dirs are the user's own network directories (directories.go):
	// GET-only and credential-free, unless verified to accept our accounts.
	dirs directoryAccess

	// test, when set (e2e builds), can delay requests, refuse them like a
	// backend that's down, and logs them — the suite's controlApi.
	test *apiTestControl
}

type apiTestControl struct {
	mu    sync.Mutex
	down  bool
	delay time.Duration
	log   []string
}

type ApiRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	// Body is a text body; BodyBase64 a binary one (an ArrayBuffer in the
	// renderer, which can't cross the bridge as JSON). At most one is set.
	Body       *string `json:"body,omitempty"`
	BodyBase64 *string `json:"bodyBase64,omitempty"`
}

type ApiResponse struct {
	Status     int    `json:"status"`
	OK         bool   `json:"ok"`
	StatusText string `json:"statusText"`
	Text       string `json:"text"`
}

const (
	apiFetchTimeout = 30 * time.Second
	apiMaxRedirects = 5
	// defaultAPIBase is used when the build doesn't set one.
	defaultAPIBase = "https://api.boson.chat"
	// defaultAuthBase is the auth service, likewise.
	defaultAuthBase = "https://auth.boson.chat"
	// defaultDirectoryBase is the network directory, likewise.
	defaultDirectoryBase = "https://directory.boson.chat"
)

// apiPolicy says which origins the proxy may reach: exact origins (the
// configured API base) plus, in dev and e2e builds only, any loopback port
// for a local backend. A release build must not let the page poke local
// services.
type apiPolicy struct {
	origins       map[string]bool
	allowLoopback bool
}

// extraBases are further exact origins (the auth service).
func newAPIPolicy(apiBase string, allowLoopback bool, extraBases ...string) apiPolicy {
	p := apiPolicy{origins: map[string]bool{}, allowLoopback: allowLoopback}
	if apiBase == "" {
		apiBase = defaultAPIBase
	}
	for _, base := range append([]string{apiBase}, extraBases...) {
		if u, err := url.Parse(base); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
			p.origins[origin(u)] = true
		}
	}
	return p
}

func NewApiService(apiBase string, allowLoopback bool, extraBases ...string) *ApiService {
	return &ApiService{
		policy: newAPIPolicy(apiBase, allowLoopback, extraBases...),
		client: &http.Client{
			// Redirects are followed by hand so every hop is checked.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func origin(u *url.URL) string {
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

func isLoopback(u *url.URL) bool {
	h := strings.ToLower(u.Hostname())
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// Exact-origin match (so https://api.boson.chat.evil.com, http://api.boson.chat
// and https://api.boson.chat:8443 are all rejected), plus loopback in dev.
func (p apiPolicy) allowed(u *url.URL) bool {
	if p.origins[origin(u)] {
		return true
	}
	return p.allowLoopback && isLoopback(u)
}

func stripCredentials(headers map[string]string) {
	for k := range headers {
		if lk := strings.ToLower(k); lk == "authorization" || lk == "cookie" {
			delete(headers, k)
		}
	}
}

func readOnlyMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead
}

func apiFail(statusText string) ApiResponse {
	return ApiResponse{Status: 0, OK: false, StatusText: statusText}
}

func (s *ApiService) Fetch(ctx context.Context, req ApiRequest) ApiResponse {
	if req.Method == "" || req.URL == "" {
		return apiFail("Bad request")
	}
	// Like the WHATWG URL parser the Electron build used: anything that isn't
	// an absolute URL is malformed.
	u, err := url.Parse(req.URL)
	if err != nil || !u.IsAbs() {
		return apiFail("Bad URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return apiFail("Bad scheme")
	}
	if u.Host == "" {
		return apiFail("Bad URL")
	}
	if t := s.test; t != nil {
		t.mu.Lock()
		t.log = append(t.log, req.Method+" "+u.RequestURI())
		down, delay := t.down, t.delay
		t.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		if down {
			return apiFail("connection refused")
		}
	}
	level := s.access(u)
	if level == accessNone {
		return apiFail("Blocked host")
	}
	if level == accessRead && !readOnlyMethod(req.Method) {
		return apiFail("Blocked method")
	}

	var body []byte
	switch {
	case req.BodyBase64 != nil:
		if body, err = base64.StdEncoding.DecodeString(*req.BodyBase64); err != nil {
			return apiFail("Bad body")
		}
	case req.Body != nil:
		body = []byte(*req.Body)
	}

	ctx, cancel := context.WithTimeout(ctx, apiFetchTimeout)
	defer cancel()

	method := req.Method
	headers := map[string]string{}
	for k, v := range req.Headers {
		headers[k] = v
	}
	if level == accessRead {
		// Someone else's directory never sees our tokens.
		stripCredentials(headers)
	}
	current := u
	for hop := 0; ; hop++ {
		var rd io.Reader
		if body != nil {
			rd = bytes.NewReader(body)
		}
		hreq, err := http.NewRequestWithContext(ctx, method, current.String(), rd)
		if err != nil {
			return apiFail("Bad request")
		}
		for k, v := range headers {
			hreq.Header.Set(k, v)
		}
		res, err := s.client.Do(hreq)
		if err != nil {
			return apiFail(err.Error())
		}

		if res.StatusCode >= 300 && res.StatusCode < 400 {
			res.Body.Close()
			if hop >= apiMaxRedirects {
				return apiFail("Too many redirects")
			}
			loc := res.Header.Get("Location")
			if loc == "" {
				return apiFail("Redirect without location")
			}
			next, err := current.Parse(loc)
			if err != nil {
				return apiFail("Bad redirect URL")
			}
			if next.Scheme != "http" && next.Scheme != "https" {
				return apiFail("Bad redirect scheme")
			}
			nextLevel := s.access(next)
			if nextLevel == accessNone {
				return apiFail("Blocked redirect host")
			}
			// Cross-origin hop: drop credential-bearing headers, as the
			// fetch spec does — defence in depth if the allowlist ever grows
			// to an origin that shouldn't see our tokens.
			if origin(next) != origin(current) || nextLevel == accessRead {
				stripCredentials(headers)
			}
			// 303 (and a non-GET/HEAD 301/302) becomes a bodyless GET.
			if res.StatusCode == http.StatusSeeOther ||
				((res.StatusCode == http.StatusMovedPermanently || res.StatusCode == http.StatusFound) && method != http.MethodGet && method != http.MethodHead) {
				method = http.MethodGet
				body = nil
			}
			// A 307/308 keeps the method: not onto a read-only origin.
			if nextLevel == accessRead && !readOnlyMethod(method) {
				return apiFail("Blocked redirect method")
			}
			current = next
			continue
		}

		text, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil {
			return apiFail(err.Error())
		}
		return ApiResponse{
			Status:     res.StatusCode,
			OK:         res.StatusCode >= 200 && res.StatusCode < 300,
			StatusText: http.StatusText(res.StatusCode),
			Text:       string(text),
		}
	}
}
