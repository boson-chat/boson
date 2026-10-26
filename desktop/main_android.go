//go:build android

package main

import (
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// In a c-shared library main() doesn't run by itself: Wails calls it once
// the Android activity has loaded the library. From Wails' Android
// template (build_assets/android/main_android.go).
func init() {
	application.RegisterAndroidMain(main)
}

// platformEnv gives the process a HOME, which Android doesn't set: the
// app's private files directory, so os.UserConfigDir (the data dir) and
// friends work.
func platformEnv() {
	if os.Getenv("HOME") == "" {
		if dir := application.Android.StoragePath(); dir != "" {
			os.Setenv("HOME", dir)
		}
	}
}
