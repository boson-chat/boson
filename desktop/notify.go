package main

import (
	"context"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// NotifyService backs the renderer's web Notification API with native
// notifications (platform/wails.ts installs a Notification class over it):
// a webview's own Notification permission only works on Windows. A
// notification's tag is its id, so repeats per conversation replace each
// other, as the web API's tag does. A click raises the window and is passed
// to the page as NotificationClickEvent.
//
// Desktop uses Wails' notifications service (notify_desktop.go); iOS
// UNUserNotificationCenter (notify_ios.go) and Android NotificationManager
// (notify_android.go), while the app runs or is briefly in the background.
// Push while it's closed isn't here.
//
// It starts the native service itself, because that refuses to start in an
// unbundled binary (no bundle id on macOS) — a dev run then just has no
// notifications rather than failing to launch.
type NotifyService struct {
	ns        platformNotifier
	win       *application.WebviewWindow
	available bool
}

// The platform's notifications.
type platformNotifier interface {
	start(ctx context.Context, opts application.ServiceOptions) error
	stop() error
	// Whether notifications are allowed; asked: whether the user has been
	// asked (false: the first request shows the system prompt).
	authorized() (ok bool, asked bool, err error)
	request() (bool, error)
	send(id, title, body string, silent bool) error
	remove(id string) error
	// A notification was tapped / clicked (its id).
	onClick(fn func(id string))
}

const NotificationClickEvent = "notification:click"

func NewNotifyService(ns platformNotifier) *NotifyService {
	n := &NotifyService{ns: ns}
	ns.onClick(func(id string) {
		if n.win != nil {
			n.win.Restore()
			n.win.Show()
			n.win.Focus()
		}
		application.Get().Event.Emit(NotificationClickEvent, id)
	})
	return n
}

func (n *NotifyService) ServiceStartup(ctx context.Context, opts application.ServiceOptions) error {
	if !nativeShell {
		return nil
	}
	if err := n.ns.start(ctx, opts); err != nil {
		log.Printf("notifications unavailable: %v", err)
		return nil
	}
	n.available = true
	return nil
}

func (n *NotifyService) ServiceShutdown() error {
	if n.available {
		return n.ns.stop()
	}
	return nil
}

// Native reports whether this build shows native notifications. A
// server-mode build runs in a browser, which has its own.
func (n *NotifyService) Native() bool { return nativeShell }

// Permission is the web API's value: "granted", "denied" or "default".
func (n *NotifyService) Permission() string {
	if !n.available {
		return "denied"
	}
	ok, asked, err := n.ns.authorized()
	switch {
	case err != nil:
		return "default"
	case ok:
		return "granted"
	case asked:
		return "denied"
	default:
		return "default"
	}
}

func (n *NotifyService) RequestPermission() string {
	if !n.available {
		return "denied"
	}
	ok, err := n.ns.request()
	if err != nil || !ok {
		return "denied"
	}
	return "granted"
}

func (n *NotifyService) Show(id, title, body string, silent bool) error {
	if !n.available {
		return nil
	}
	return n.ns.send(id, title, body, silent)
}

func (n *NotifyService) Close(id string) error {
	if !n.available {
		return nil
	}
	return n.ns.remove(id)
}
