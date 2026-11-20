//go:build android && cgo

package main

// newScreenAwake keeps the phone's screen on during a call:
// BosonVoice.keepScreenOn sets or clears FLAG_KEEP_SCREEN_ON on the
// activity's window (on the UI thread).
func newScreenAwake() func(on bool) {
	return func(on bool) {
		v := 0
		if on {
			v = 1
		}
		javaVoidInt("keepScreenOn", v)
	}
}
