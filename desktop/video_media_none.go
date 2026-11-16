//go:build !cgo || server || (linux && !android && !videocapture) || !(darwin || windows || linux)

package main

// No native capture in this build (Android for now, Linux release builds,
// cgo-less and server builds): calls can be watched but not sent to.
func newVideoMedia() videoMedia { return nil }
