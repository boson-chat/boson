//go:build !ios && !android

package main

// Desktop: no push while the app is closed yet (docs/push.md §3.2: phase 2,
// through the relay with APNs on macOS and FCM or UnifiedPush on Linux and
// Windows). The app notifies while it runs (notify.go), and always-on
// accounts catch up on reconnect.
//
// TODO(push, phase 2): a pushPlatform for macOS (APNs via the relay; needs
// a signed app with the aps-environment entitlement) and Linux/Windows.
func newPushPlatform(dataDir string, dev bool) pushPlatform { return nil }
