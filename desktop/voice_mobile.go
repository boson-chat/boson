//go:build ios || android

package main

import (
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// No voice on iOS/Android yet: no VoiceService, so the renderer shows none.
// Network sign-in discovery (netauth.go) and file uploads (files.go) are
// here as on desktop, on the same boson.json discoverer (voice_discovery.go;
// they only read boson.json, never probe for a voice server). Uploads go in
// ArrayBuffer chunks to /_boson/files/ on the app's origin, which WKWebView's
// custom-scheme handler passes through whole on iOS as on macOS. The image
// cache previews uploaded files from the same allowed hosts.
func voiceServices(dataDir, _ string, dev bool, api *ApiService, images *ImageCacheService) ([]application.Service, http.Handler) {
	disc := newVoiceDiscoverer(dataDir, dev)
	fs := NewFilesService(disc, api, dev)
	images.useFiles(fs)
	return []application.Service{
		application.NewService(NewNetAuthService(disc, api)),
		application.NewService(fs),
	}, fs
}
