//go:build android && cgo && !server

package main

import "errors"

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
