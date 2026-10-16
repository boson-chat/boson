package main

import (
	"os"
	"time"
)

// E2EService lets the e2e suite do what the OS would: deliver a deep link as
// a second launch, and read which links were handed to the browser. Only in
// dev builds run with BOSON_E2E=1; Enabled reports whether it's live, and
// every other method is a no-op otherwise.
type E2EService struct {
	enabled   bool
	links     *LinksService
	deepLinks *DeepLinkService
	api       *apiTestControl
}

func NewE2EService(allow bool, links *LinksService, deepLinks *DeepLinkService, api *ApiService) *E2EService {
	e := &E2EService{enabled: allow && os.Getenv("BOSON_E2E") == "1", links: links, deepLinks: deepLinks}
	if e.enabled {
		e.api = &apiTestControl{}
		api.test = e.api
	}
	return e
}

// SetApi makes API requests fail like a backend that's down, or wait first.
func (e *E2EService) SetApi(down bool, delayMs int) {
	if e.api == nil {
		return
	}
	e.api.mu.Lock()
	e.api.down, e.api.delay = down, time.Duration(delayMs)*time.Millisecond
	e.api.mu.Unlock()
}

// ApiRequests lists "METHOD /path?query" for every API request so far.
func (e *E2EService) ApiRequests() []string {
	if e.api == nil {
		return []string{}
	}
	e.api.mu.Lock()
	defer e.api.mu.Unlock()
	return append([]string{}, e.api.log...)
}

func (e *E2EService) Enabled() bool { return e.enabled }

// SecondInstance behaves as if the app were launched again with args (how a
// boson:// click reaches a running app on Windows/Linux).
func (e *E2EService) SecondInstance(args []string) {
	if e.enabled {
		e.deepLinks.onSecondInstance(args)
	}
}

func (e *E2EService) OpenedLinks() []string {
	if !e.enabled {
		return []string{}
	}
	return e.links.Opened()
}
