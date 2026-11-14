package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// The user's own network directories. The renderer keeps the list (Settings →
// Directories) and hands it to the proxy with SetDirectories; each entry is
// re-validated here, since the renderer is the thing the allowlist guards
// against:
//
//   - https only (http to loopback in dev builds), an exact origin: no
//     userinfo, path, query or fragment, no wildcards;
//   - never an IP literal in a private, loopback (release), link-local or
//     unspecified range — the list must not become a way to probe the LAN;
//   - read-only: GET/HEAD, with Authorization and Cookie stripped.
//
// A directory gets owner access (any method, credentials forwarded) only
// when the proxy itself has fetched its /.well-known/boson-directory.json
// and found an auth_issuer equal to the app's auth service: it accepts our
// accounts, so sending it our access token is what the user asked for. The
// build's default directory (directory.boson.chat) always has owner access,
// like the API and auth origins.

type accessLevel int

const (
	accessNone accessLevel = iota
	accessRead
	accessFull
)

// maxDirectories bounds the list (the renderer allows 8).
const maxDirectories = 16

// DirectoryEntry is one directory the renderer browses: its origin, the
// origin its API lives on (default: the same), and whether it should be
// checked for owner access.
type DirectoryEntry struct {
	URL   string `json:"url"`
	API   string `json:"api,omitempty"`
	Owner bool   `json:"owner,omitempty"`
}

type directoryAccess struct {
	mu   sync.RWMutex
	read map[string]bool
	full map[string]bool
	// gen invalidates owner checks still running for an older list.
	gen int
	// authOrigin is the app's auth service, for the owner check.
	authOrigin string
}

// access says what the proxy may do at u: the build's own origins first,
// then the user's directories.
func (s *ApiService) access(u *url.URL) accessLevel {
	if s.policy.allowed(u) {
		return accessFull
	}
	o := origin(u)
	s.dirs.mu.RLock()
	defer s.dirs.mu.RUnlock()
	switch {
	case s.dirs.full[o]:
		return accessFull
	case s.dirs.read[o]:
		return accessRead
	}
	return accessNone
}

// TrustAuth records the auth service the owner check compares against.
func (s *ApiService) TrustAuth(authBase string) {
	if u, err := url.Parse(authBase); err == nil && u.Host != "" {
		s.dirs.mu.Lock()
		s.dirs.authOrigin = origin(u)
		s.dirs.mu.Unlock()
	}
}

// directoryOrigin validates one directory address and returns its origin.
func (s *ApiService) directoryOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !u.IsAbs() || u.Host == "" || u.Opaque != "" {
		return "", errors.New("bad url")
	}
	if u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return "", errors.New("not an origin")
	}
	host := u.Hostname()
	if strings.ContainsAny(host, "*") {
		return "", errors.New("wildcard")
	}
	loop := isLoopback(u)
	switch u.Scheme {
	case "https":
	case "http":
		if !(s.policy.allowLoopback && loop) {
			return "", errors.New("https only")
		}
	default:
		return "", errors.New("bad scheme")
	}
	if loop && !s.policy.allowLoopback {
		return "", errors.New("loopback")
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil && !(loop && s.policy.allowLoopback) {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
			return "", errors.New("private address")
		}
	}
	return origin(u), nil
}

// SetDirectories replaces the user's directory list (read access at once;
// owner access after its check). Invalid entries are skipped and reported.
func (s *ApiService) SetDirectories(entries []DirectoryEntry) []string {
	var rejected []string
	read := map[string]bool{}
	type ownerCheck struct{ dir, api string }
	var checks []ownerCheck
	for i, e := range entries {
		if i >= maxDirectories {
			rejected = append(rejected, e.URL)
			continue
		}
		dir, err := s.directoryOrigin(e.URL)
		if err != nil {
			rejected = append(rejected, e.URL)
			continue
		}
		api := dir
		if e.API != "" {
			if a, err := s.apiOriginOf(e.API); err == nil {
				api = a
			} else {
				rejected = append(rejected, e.API)
				continue
			}
		}
		read[dir], read[api] = true, true
		if e.Owner {
			checks = append(checks, ownerCheck{dir, api})
		}
	}
	s.dirs.mu.Lock()
	s.dirs.gen++
	gen := s.dirs.gen
	// Keep owner access already proven for directories still listed, so a
	// re-sync doesn't briefly break an open hosting dialog.
	full := map[string]bool{}
	for _, c := range checks {
		if s.dirs.full[c.api] {
			full[c.api] = true
		}
	}
	s.dirs.read, s.dirs.full = read, full
	s.dirs.mu.Unlock()
	for _, c := range checks {
		go s.checkOwner(gen, c.dir, c.api)
	}
	return rejected
}

// apiOriginOf validates an API base (it may carry a path) and returns its
// origin.
func (s *ApiService) apiOriginOf(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", errors.New("bad url")
	}
	return s.directoryOrigin((&url.URL{Scheme: u.Scheme, Host: u.Host}).String())
}

// wellKnown is the part of /.well-known/boson-directory.json the owner
// check reads.
type wellKnown struct {
	Name       string `json:"name"`
	API        string `json:"api"`
	AuthIssuer string `json:"auth_issuer"`
}

func (s *ApiService) fetchWellKnown(ctx context.Context, dir string) (*wellKnown, int, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, dir+"/.well-known/boson-directory.json", nil)
	if err != nil {
		return nil, 0, "", err
	}
	req.Header.Set("Accept", "application/json")
	// s.client doesn't follow redirects: the document must be at the origin.
	res, err := s.client.Do(req)
	if err != nil {
		return nil, 0, "", err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return nil, 0, "", err
	}
	if res.StatusCode != http.StatusOK {
		return nil, res.StatusCode, string(body), errors.New(http.StatusText(res.StatusCode))
	}
	var wk wellKnown
	if err := json.Unmarshal(body, &wk); err != nil || wk.Name == "" {
		return nil, res.StatusCode, string(body), errors.New("not a boson directory")
	}
	return &wk, res.StatusCode, string(body), nil
}

func (s *ApiService) checkOwner(gen int, dir, api string) {
	wk, _, _, err := s.fetchWellKnown(context.Background(), dir)
	if err != nil {
		return
	}
	issuer, err := url.Parse(wk.AuthIssuer)
	if err != nil || issuer.Host == "" {
		return
	}
	declared := dir
	if wk.API != "" {
		if a, err := url.Parse(wk.API); err == nil && a.Host != "" {
			declared = origin(a)
		} else if err == nil && a.Host == "" {
			declared = dir // a relative api path stays on the directory
		}
	}
	s.dirs.mu.Lock()
	defer s.dirs.mu.Unlock()
	if gen != s.dirs.gen || s.dirs.authOrigin == "" || origin(issuer) != s.dirs.authOrigin || declared != api {
		return
	}
	s.dirs.full[api] = true
}

// CheckDirectory fetches a directory's well-known document before the user
// adds it (it isn't on the list yet, so Fetch would refuse it). Only that one
// path, GET, no credentials, at a validated origin.
func (s *ApiService) CheckDirectory(ctx context.Context, rawURL string) ApiResponse {
	dir, err := s.directoryOrigin(rawURL)
	if err != nil {
		return apiFail("Blocked host")
	}
	_, status, body, err := s.fetchWellKnown(ctx, dir)
	if status == 0 {
		return apiFail(err.Error())
	}
	// The renderer validates the document itself; hand back what came.
	return ApiResponse{Status: status, OK: status >= 200 && status < 300, StatusText: http.StatusText(status), Text: body}
}
