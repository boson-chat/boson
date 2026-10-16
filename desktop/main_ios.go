//go:build ios

package main

import "C"

// WailsIOSMain runs main() for the iOS app (build/ios/main.m). Wails'
// WailsAppDelegate calls it from didFinishLaunchingWithOptions, on a
// background thread, once UIKit has launched — so the Go runtime never
// starts while UIApplicationMain is still handshaking with the system
// (that race gives a blank cold launch on devices). From Wails' iOS
// template (build_assets/ios/main_ios.go).
//
//export WailsIOSMain
func WailsIOSMain() {
	main()
}
