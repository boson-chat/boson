package main

import (
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// DeepLinkService routes boson:// URLs (the website's "join" links and the
// sign-up confirmation) to the renderer. They arrive as a macOS open-URL
// event, in the launch arguments (Windows/Linux cold start), or in a second
// launch's arguments (Windows/Linux, via the single-instance lock).
//
// A URL is always buffered AND sent live: on a cold
// start the renderer isn't listening yet and drains the buffer with Consume
// once it is; the renderer dedupes when both paths deliver it.
type DeepLinkService struct {
	win *application.WebviewWindow

	mu      sync.Mutex
	pending string
}

const (
	DeepLinkEvent  = "deep-link:join"
	deepLinkScheme = "boson://"
)

// Consume returns and clears the buffered URL ("" when there is none).
func (d *DeepLinkService) Consume() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	u := d.pending
	d.pending = ""
	return u
}

func (d *DeepLinkService) dispatch(url string) {
	if !strings.HasPrefix(strings.ToLower(url), deepLinkScheme) {
		return
	}
	d.mu.Lock()
	d.pending = url
	d.mu.Unlock()
	application.Get().Event.Emit(DeepLinkEvent, url)
	d.raise()
}

func (d *DeepLinkService) raise() {
	if d.win != nil {
		d.win.Restore()
		d.win.Show()
		d.win.Focus()
	}
}

// fromArgs finds the boson:// URL among launch arguments.
func deepLinkFromArgs(args []string) string {
	for _, a := range args {
		if strings.HasPrefix(strings.ToLower(a), deepLinkScheme) {
			return a
		}
	}
	return ""
}

// attach wires the OS sources once the app and its window exist.
func (d *DeepLinkService) attach(app *application.App, win *application.WebviewWindow, launchArgs []string) {
	d.win = win
	app.Event.OnApplicationEvent(events.Common.ApplicationLaunchedWithUrl, func(e *application.ApplicationEvent) {
		d.dispatch(e.Context().URL())
	})
	if u := deepLinkFromArgs(launchArgs); u != "" {
		d.mu.Lock()
		d.pending = u
		d.mu.Unlock()
	}
}

// onSecondInstance handles a second launch (Windows/Linux deep link click
// while running): its args may carry the URL.
func (d *DeepLinkService) onSecondInstance(args []string) {
	if u := deepLinkFromArgs(args); u != "" {
		d.dispatch(u)
		return
	}
	d.raise()
}
