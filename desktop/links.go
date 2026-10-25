package main

import (
	"errors"
	"net/url"
	"os"
	"sync"
)

// LinksService opens web links in the user's browser (on iOS, in an in-app
// Safari view: links_ios.go). The renderer routes
// window.open and any navigation away from the app here (platform/wails.ts):
// Wails can't intercept them natively. Only http(s) URLs are opened; other
// schemes are dropped.
//
// In e2e builds (BOSON_E2E_RECORD_LINKS=1) it records URLs instead of
// opening them, and Opened lists them — the suite's openedExternally().
type LinksService struct {
	record bool

	mu     sync.Mutex
	opened []string
}

func NewLinksService(allowRecord bool) *LinksService {
	return &LinksService{record: allowRecord && os.Getenv("BOSON_E2E_RECORD_LINKS") == "1"}
}

var errNotWebURL = errors.New("links: only http(s) URLs are opened")

func (l *LinksService) Open(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errNotWebURL
	}
	if l.record {
		l.mu.Lock()
		l.opened = append(l.opened, u.String())
		l.mu.Unlock()
		return nil
	}
	return openLink(u.String())
}

// Opened returns the recorded URLs (e2e builds only; empty otherwise).
func (l *LinksService) Opened() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.opened...)
}
