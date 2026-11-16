//go:build darwin && !ios && !server

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit
#import <AppKit/AppKit.h>

// The window itself stops being a file-drop target. Wails registers it for
// NSFilenamesPboardType and, on a drop the web view didn't take, reads the
// file names synchronously on the main thread. A macOS screenshot dragged
// from its floating thumbnail is a file *promise* that isn't on disk yet:
// that read blocked until it was, freezing the app. Drops are the web
// view's (the renderer's drop handlers); the window never needed them.
static void bosonStopWindowFileDrops(void *w) {
	[(NSWindow *)w unregisterDraggedTypes];
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

func stopWindowFileDrops(win *application.WebviewWindow) {
	stop := func() {
		application.InvokeSync(func() {
			if p := win.NativeWindow(); p != nil {
				C.bosonStopWindowFileDrops(p)
			}
		})
	}
	win.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) { stop() })
}
