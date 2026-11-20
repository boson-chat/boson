package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Metered networks (data saver): the phone's system network events say
// whether the connection costs money. iOS (NWPathMonitor): expensive
// (cellular, a personal hotspot) or constrained (Low Data Mode). Android
// (ConnectivityManager): not NET_CAPABILITY_NOT_METERED. Desktops never
// report one, so data saver's Auto stays off there.
var networkEvents = []events.ApplicationEventType{
	events.IOS.NetworkChanged,
	events.Android.NetworkChanged,
}

func (v *VideoService) watchNetwork(app *application.App) {
	if app == nil {
		return
	}
	for _, e := range networkEvents {
		app.Event.OnApplicationEvent(e, func(ev *application.ApplicationEvent) {
			v.setMetered(meteredNetwork(ev.Context().Data()))
		})
	}
}

// meteredNetwork reads a NetworkChanged event's payload.
func meteredNetwork(data map[string]any) bool {
	is := func(k string) bool { b, _ := data[k].(bool); return b }
	if connected, ok := data["connected"].(bool); ok && !connected {
		return false
	}
	return is("metered") || is("expensive") || is("constrained")
}

func (v *VideoService) setMetered(m bool) {
	v.mu.Lock()
	if v.metered != m {
		v.metered = m
		v.dirty = true
	}
	v.mu.Unlock()
}

// Camera quality settings: the top of the camera's layer ladder.
const (
	CameraQualityAuto  = "auto"  // 720p
	CameraQualitySaver = "saver" // 360p (data saver)
	CameraQualityHigh  = "high"  // 1080p when the camera has it
)

// SetCameraQuality sets what the camera sends: auto | saver | high
// (anything else = auto). The renderer passes "saver" while data saver is
// on. A running camera restarts with the new ladder.
func (v *VideoService) SetCameraQuality(q string) VideoState {
	switch q {
	case CameraQualitySaver, CameraQualityHigh:
	default:
		q = CameraQualityAuto
	}
	v.mu.Lock()
	changed := v.camQuality != q && !(v.camQuality == "" && q == CameraQualityAuto)
	v.camQuality = q
	cam := v.st.camera
	restart := changed && (cam.on || cam.starting) && v.st.camWant
	id := v.st.camWantID
	v.dirty = v.dirty || changed
	v.mu.Unlock()
	if restart {
		v.setShare(true, true, id)
	}
	return v.State()
}
