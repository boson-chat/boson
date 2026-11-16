//go:build cgo && !server && !android && (darwin || windows || (linux && videocapture))

package main

// cameraAllowed: on desktop and iOS the media package asks (TCC).
func cameraAllowed() error { return nil }

// cameraTurning: iOS and desktop rotate frames themselves (Android only).
func cameraTurning(bool) {}
