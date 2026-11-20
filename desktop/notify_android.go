//go:build android

package main

import (
	"context"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Android: NotificationManager (BosonVoice.notify), while the app runs or
// is briefly in the background. Android 13+ asks for POST_NOTIFICATIONS the
// first time. A tap opens the app and MainActivity emits
// "notification:click" itself.
type androidNotifier struct{}

func newPlatformNotifier() platformNotifier { return androidNotifier{} }

func (androidNotifier) start(context.Context, application.ServiceOptions) error { return nil }
func (androidNotifier) stop() error                                             { return nil }

func (androidNotifier) authorized() (bool, bool, error) {
	s := notifyJavaInt(0)
	return s == 1, s != 2, nil
}

// Called off the UI thread: waits for the answer to the system prompt.
func (androidNotifier) request() (bool, error) { return notifyJavaInt(1) == 1, nil }

func (androidNotifier) send(id, title, body string, silent bool) error {
	s := "0"
	if silent {
		s = "1"
	}
	clean := func(v string) string { return strings.ReplaceAll(v, "\n", " ") }
	notifyJavaStrings("notify", clean(id)+"\n"+clean(title)+"\n"+s, body)
	return nil
}

func (androidNotifier) remove(id string) error {
	notifyJavaStrings("cancelNotify", id, "")
	return nil
}

func (androidNotifier) onClick(func(id string)) {}
