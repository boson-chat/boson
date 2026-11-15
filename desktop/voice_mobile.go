//go:build ios || android

package main

import (
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// No voice (or file uploads) on iOS/Android yet: no VoiceService or
// FilesService, so the renderer shows none.
func voiceServices(string, string, bool, *ApiService, *ImageCacheService) ([]application.Service, http.Handler) {
	return nil, nil
}
