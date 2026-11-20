//go:build !ios && !(android && cgo)

package main

// newScreenAwake: desktops don't lock during a call on our account (the
// OS's own rules apply); phones keep the screen on (screen_awake_*.go).
func newScreenAwake() func(on bool) { return nil }
