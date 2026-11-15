//go:build cgo && !novoiceaudio && !android

package main

import "github.com/boson-chat/boson/desktop/internal/micperm"

// micpermAccess is the OS microphone permission through micperm (macOS and
// iOS ask; elsewhere it's always granted), asking for it when request is
// set and nobody has answered yet.
func micpermAccess(request bool) micAccess {
	switch micperm.Status() {
	case micperm.Granted:
		return micGranted
	case micperm.Denied:
		return micDenied
	default:
		if request && micperm.Request() {
			return micGranted
		} else if request {
			return micDenied
		}
		return micUndetermined
	}
}
