//go:build ios || android

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// No voice on iOS/Android yet: no VoiceService, so the renderer shows none.
func voiceServices(string, string, bool) []application.Service { return nil }
