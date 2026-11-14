//go:build !ios && !android

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// voiceServices is the voice service on desktop (none on iOS/Android), and
// the network sign-in discovery that shares its boson.json lookups.
func voiceServices(dataDir, authBase string, dev bool, api *ApiService) []application.Service {
	voice := NewVoiceService(dataDir, authBase, dev)
	voice.nets = api.nets
	return []application.Service{
		application.NewService(voice),
		application.NewService(NewNetAuthService(voice.disc, api)),
	}
}
