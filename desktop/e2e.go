package main

import (
	"os"
	"time"
)

// E2EService lets the e2e suite do what the OS, the network or a crash
// would: deliver a deep link as a second launch, read which links were
// handed to the browser, take the backend down, kill the engine, serve
// Spotify's embed pages, and push update states. Only in dev builds run with
// BOSON_E2E=1; Enabled reports whether it's live, and every other method is
// a no-op otherwise.
type E2EService struct {
	enabled bool
	t       e2eTargets
	api     *apiTestControl
}

// e2eTargets are the services the hooks reach into.
type e2eTargets struct {
	links     *LinksService
	deepLinks *DeepLinkService
	api       *ApiService
	engine    *EngineService
	spotify   *SpotifyService
	updater   *UpdaterService
}

func NewE2EService(allow bool, t e2eTargets) *E2EService {
	e := &E2EService{enabled: allow && os.Getenv("BOSON_E2E") == "1", t: t}
	if e.enabled {
		e.api = &apiTestControl{}
		t.api.test = e.api
		t.spotify.test = &spotifyTestControl{pages: map[string]string{}}
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
		e.t.deepLinks.onSecondInstance(args)
	}
}

func (e *E2EService) OpenedLinks() []string {
	if !e.enabled {
		return []string{}
	}
	return e.t.links.Opened()
}

// CrashEngine ends the engine session as a crash of the Electron build's
// engine process would: IRC connections drop without a QUIT, and the
// renderer loses its connection (and reconnects, to a new session). Returns
// the ended session's id (0: none was open).
func (e *E2EService) CrashEngine() int {
	if !e.enabled {
		return 0
	}
	return e.t.engine.crash()
}

// EngineSession is the open engine session's id (0: none) — what the
// Electron suite reads as the engine's PID.
func (e *E2EService) EngineSession() int {
	if !e.enabled {
		return 0
	}
	return e.t.engine.session()
}

// StubSpotify serves these embed pages (URL → HTML) in place of
// open.spotify.com; any other embed page is a 404.
func (e *E2EService) StubSpotify(pages map[string]string) {
	if !e.enabled {
		return
	}
	c := e.t.spotify.test
	c.mu.Lock()
	c.pages = pages
	c.mu.Unlock()
}

// SpotifyFetched lists the embed pages asked for so far.
func (e *E2EService) SpotifyFetched() []string {
	if !e.enabled {
		return []string{}
	}
	c := e.t.spotify.test
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string{}, c.fetched...)
}

// PushUpdaterState sets the updater's state and pushes it to the renderer,
// as a real check or download would.
func (e *E2EService) PushUpdaterState(s UpdateState) {
	if e.enabled {
		e.t.updater.set(s)
	}
}
