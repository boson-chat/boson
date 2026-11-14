//go:build !ios && !android

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// voiceServices is the voice service on desktop (none on iOS/Android).
func voiceServices(dataDir, authBase string, dev bool) []application.Service {
	return []application.Service{application.NewService(NewVoiceService(dataDir, authBase, dev))}
}
