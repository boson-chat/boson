package main

import (
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// voiceServices is the voice service (desktop, iOS and Android), and the
// network sign-in discovery and files uploads that share its boson.json
// lookups. files serves /_boson/files/ on the app's origin (assetHandler).
// The image cache previews uploaded files from the same allowed hosts.
func voiceServices(dataDir, authBase string, dev bool, api *ApiService, images *ImageCacheService) (services []application.Service, files http.Handler) {
	voice := NewVoiceService(dataDir, authBase, dev)
	voice.nets = api.nets
	// Every voice channel is also a video channel (where the server has it).
	video := NewVideoService()
	video.dev = dev
	video.offsets = voice.avOffsets
	video.audioDelay = voice.setAudioDelay
	video.sounds = voice // screen shares' sound plays through the voice engine
	voice.video = video
	// The "Leave" action on Android's in-call notification.
	setNotificationLeave(voice.Leave)
	fs := NewFilesService(voice.disc, api, dev)
	images.useFiles(fs)
	return []application.Service{
		application.NewService(voice),
		application.NewService(video),
		application.NewService(NewNetAuthService(voice.disc, api)),
		application.NewService(fs),
	}, fs
}
