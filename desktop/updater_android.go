//go:build android

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// installAPK hands a verified update APK to the system package installer.
// The Java shell's openURL (WailsBridge.java) turns a file:// URL inside the
// app's updates folder into an install Intent through its FileProvider
// (asking for "install unknown apps" first if needed); Android checks the
// APK is signed with the installed app's key.
func installAPK(path string) error {
	application.Mobile.OpenURL("file://" + path)
	return nil
}
