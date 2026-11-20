package main

import (
	"slices"
	"testing"
)

func TestMeteredNetwork(t *testing.T) {
	for _, c := range []struct {
		data map[string]any
		want bool
	}{
		{map[string]any{"connected": true, "type": "cellular", "metered": true}, true},     // Android
		{map[string]any{"connected": true, "type": "wifi", "metered": false}, false},       // Android
		{map[string]any{"connected": true, "expensive": true, "constrained": false}, true}, // iOS cellular / hotspot
		{map[string]any{"connected": true, "expensive": false, "constrained": true}, true}, // iOS Low Data Mode
		{map[string]any{"connected": true, "expensive": false, "constrained": false}, false},
		{map[string]any{"connected": false, "metered": true}, false},
		{nil, false},
	} {
		if got := meteredNetwork(c.data); got != c.want {
			t.Errorf("%v: %v, want %v", c.data, got, c.want)
		}
	}
}

func TestVideoCameraQuality(t *testing.T) {
	h := newVideoHarness(t)
	if st := h.svc.State(); st.CameraQuality != "auto" || st.Metered {
		t.Fatalf("defaults: %+v", st)
	}
	h.svc.setMetered(true)
	if !h.svc.State().Metered {
		t.Fatal("metered not reported")
	}
	// Before the camera is on: remembered for its start.
	h.svc.SetCameraQuality("saver")
	h.join(t, `"video.publish"`)
	h.svc.SetCamera(true, "")
	waitUntil(t, "camera on", func() bool { return h.svc.State().Camera.On })
	// A change restarts the running camera with the new ladder; the same
	// value again (or an unknown one mapping to it) doesn't.
	h.svc.SetCameraQuality("high")
	waitUntil(t, "camera restarted", func() bool {
		h.media.mu.Lock()
		defer h.media.mu.Unlock()
		return len(h.media.camQualities) == 2
	})
	waitUntil(t, "camera back on", func() bool { return h.svc.State().Camera.On })
	h.svc.SetCameraQuality("high")
	if st := h.svc.SetCameraQuality("bogus"); st.CameraQuality != "auto" {
		t.Fatalf("unknown quality: %q", st.CameraQuality)
	}
	waitUntil(t, "restarted at auto", func() bool {
		h.media.mu.Lock()
		defer h.media.mu.Unlock()
		return len(h.media.camQualities) == 3
	})
	h.media.mu.Lock()
	got := slices.Clone(h.media.camQualities)
	h.media.mu.Unlock()
	if !slices.Equal(got, []string{"saver", "high", "auto"}) {
		t.Fatalf("camera qualities %v", got)
	}
	// Off: changing it starts nothing.
	h.svc.SetCamera(false, "")
	h.svc.SetCameraQuality("saver")
	h.media.mu.Lock()
	n := len(h.media.camQualities)
	h.media.mu.Unlock()
	if n != 3 {
		t.Fatalf("camera started while off: %d", n)
	}
}
