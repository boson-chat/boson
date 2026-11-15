//go:build !android || !cgo

package main

// Desktop and iOS tell the OS nothing about a call: iOS keeps a call alive
// in the background through its audio session (UIBackgroundModes audio),
// which voice_device_ios.go opens.
func newCallNotifier() callNotifier { return nil }

func setNotificationLeave(func()) {}
