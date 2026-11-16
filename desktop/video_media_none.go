//go:build !cgo || server || ios || android || (linux && !videocapture) || !(darwin || windows || linux)

package main

// No native capture in this build (phones for now, cgo-less and server
// builds): calls can be watched but not sent to.
func newVideoMedia() videoMedia { return nil }
