package main

import (
	"context"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// NotifyService backs the renderer's web Notification API with native
// notifications (platform/wails.ts installs a Notification class over it):
// a webview's own Notification permission only works on Windows. A
// notification's tag is its id, so repeats per conversation replace each
// other, as the web API's tag does. A click raises the window and is passed
// to the page as NotificationClickEvent.
//
// It starts the native service itself, because that refuses to start in an
// unbundled binary (no bundle id on macOS) — a dev run then just has no
// notifications rather than failing to launch.
type NotifyService struct {
	ns        *notifications.NotificationService
	win       *application.WebviewWindow
	available bool
}

const NotificationClickEvent = "notification:click"

func NewNotifyService(ns *notifications.NotificationService) *NotifyService {
	n := &NotifyService{ns: ns}
	ns.OnNotificationResponse(func(r notifications.NotificationResult) {
		if r.Error != nil || r.Response.ActionIdentifier != notifications.DefaultActionIdentifier {
			return
		}
		if n.win != nil {
			n.win.Restore()
			n.win.Show()
			n.win.Focus()
		}
		application.Get().Event.Emit(NotificationClickEvent, r.Response.ID)
	})
	return n
}

func (n *NotifyService) ServiceStartup(ctx context.Context, opts application.ServiceOptions) error {
	if !nativeShell {
		return nil
	}
	if err := n.ns.ServiceStartup(ctx, opts); err != nil {
		log.Printf("notifications unavailable: %v", err)
		return nil
	}
	n.available = true
	return nil
}

func (n *NotifyService) ServiceShutdown() error {
	if n.available {
		return n.ns.ServiceShutdown()
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
	ok, err := n.ns.CheckNotificationAuthorization()
	switch {
	case err != nil:
		return "default"
	case ok:
		return "granted"
	default:
		return "default"
	}
}

func (n *NotifyService) RequestPermission() string {
	if !n.available {
		return "denied"
	}
	ok, err := n.ns.RequestNotificationAuthorization()
	if err != nil || !ok {
		return "denied"
	}
	return "granted"
}

func (n *NotifyService) Show(id, title, body string, silent bool) error {
	if !n.available {
		return nil
	}
	opts := notifications.NotificationOptions{ID: id, Title: title, Body: body}
	if silent {
		opts.Sound = &notifications.NotificationSound{Silent: true}
	}
	return n.ns.SendNotification(opts)
}

func (n *NotifyService) Close(id string) error {
	if !n.available {
		return nil
	}
	return n.ns.RemoveNotification(id)
}
