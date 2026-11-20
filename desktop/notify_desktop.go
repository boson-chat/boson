//go:build !ios && !android

package main

import (
	"context"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// Desktop notifications: Wails' service (macOS, Windows, Linux).
type wailsNotifier struct {
	ns *notifications.NotificationService
}

func newPlatformNotifier() platformNotifier { return &wailsNotifier{ns: notifications.New()} }

func (w *wailsNotifier) start(ctx context.Context, opts application.ServiceOptions) error {
	return w.ns.ServiceStartup(ctx, opts)
}
func (w *wailsNotifier) stop() error { return w.ns.ServiceShutdown() }

// Desktop systems ask on first use; a refusal reads as not asked (the
// renderer then asks, which shows nothing new).
func (w *wailsNotifier) authorized() (bool, bool, error) {
	ok, err := w.ns.CheckNotificationAuthorization()
	return ok, false, err
}
func (w *wailsNotifier) request() (bool, error) { return w.ns.RequestNotificationAuthorization() }

func (w *wailsNotifier) send(id, title, body string, silent bool) error {
	opts := notifications.NotificationOptions{ID: id, Title: title, Body: body}
	if silent {
		opts.Sound = &notifications.NotificationSound{Silent: true}
	}
	return w.ns.SendNotification(opts)
}
func (w *wailsNotifier) remove(id string) error { return w.ns.RemoveNotification(id) }

func (w *wailsNotifier) onClick(fn func(id string)) {
	w.ns.OnNotificationResponse(func(r notifications.NotificationResult) {
		if r.Error != nil || r.Response.ActionIdentifier != notifications.DefaultActionIdentifier {
			return
		}
		fn(r.Response.ID)
	})
}
