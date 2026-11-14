//go:build (!cgo || novoiceaudio) && !ios && !android

package main

import "errors"

// Builds without cgo, or with -tags novoiceaudio (the e2e server build),
// have no voice audio: libopus and miniaudio are C. Discovery and room
// lists still work; joining reports that this build can't.
const voiceAudioCompiled = false

var errVoiceAudioUnavailable = errors.New("this build has no voice audio (built without cgo or with novoiceaudio)")

var newAudioBackend func() (audioBackend, error)

func micPermission(bool) micAccess { return micGranted }
