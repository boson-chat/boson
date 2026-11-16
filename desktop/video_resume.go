package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// resumeEvents are the system's "the app is back" moments that turn a
// camera the system stopped back on (VideoService.ResumeCamera): iOS and
// Android stop the camera in the background, and a Mac's stalls in sleep.
// The renderer also calls ResumeCamera when the webview becomes visible.
// (Not every focus change: a Mac app becomes active on each click into it.)
var resumeEvents = []events.ApplicationEventType{
	events.IOS.ApplicationDidBecomeActive,
	events.Android.ActivityResumed,
	events.Mac.ApplicationDidWake,
	events.Common.SystemDidWake,
}

func (v *VideoService) watchResume(app *application.App) {
	if app == nil {
		return
	}
	for _, e := range resumeEvents {
		app.Event.OnApplicationEvent(e, func(*application.ApplicationEvent) { go v.ResumeCamera() })
	}
}
