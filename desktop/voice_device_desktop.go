//go:build cgo && !novoiceaudio && !ios && !android

package main

import "github.com/boson-chat/quicvoice/client/voice"

// Desktop: quicvoice's miniaudio duplex device, at quicvoice's default
// bitrate.
const voiceBitrate = 32000

func openAudioDevice() (audioDevice, error) { return voice.NewAudio() }

func micPermission(request bool) micAccess { return micpermAccess(request) }
