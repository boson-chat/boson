//go:build android && cgo && !server

package main

import (
	"errors"
	"sync/atomic"
)

var errCameraDenied = errors.New("camera access is off for Boson: allow it in Settings → Apps → Boson → Permissions")

// cameraAllowed asks for the CAMERA runtime permission (the system
// prompt, the first time) and waits for the answer.
func cameraAllowed() error {
	switch javaInt("cameraPermission", "(I)I", 1) {
	case 1, -1: // granted, or no Java side: let the camera say
		return nil
	default:
		return errCameraDenied
	}
}

// cameraTurning counts running cameras; while any runs, BosonVoice's
// orientation listener reports how the phone is held (nativeOrientation →
// media.SetDeviceOrientation), so a phone on its side sends upright video.
var turning atomic.Int32

func cameraTurning(on bool) {
	n := turning.Add(map[bool]int32{true: 1, false: -1}[on])
	if (on && n == 1) || (!on && n == 0) {
		javaVoidInt("watchOrientation", map[bool]int{true: 1, false: 0}[on])
	}
}
