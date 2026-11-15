//go:build ios && cgo && !novoiceaudio

package main

/*
#cgo LDFLAGS: -framework AVFoundation -framework AudioToolbox
#include "voice_device_ios.h"
*/
import "C"

import (
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/boson-chat/quicvoice/client/voice"
)

// iOS: a phone's data plan, so a little under desktop's 32 kbit/s.
const voiceBitrate = 24000

// iosEngine is the engine the audio unit's callbacks feed (one device at
// a time; nil while stopped).
var iosEngine atomic.Pointer[voice.Engine]

//export bosonVoiceCapture
func bosonVoiceCapture(p *C.int16_t, n C.int) {
	if e := iosEngine.Load(); e != nil && n > 0 {
		e.Capture(unsafe.Slice((*int16)(unsafe.Pointer(p)), int(n)))
	}
}

//export bosonVoicePlayback
func bosonVoicePlayback(p *C.int16_t, n C.int) {
	if n <= 0 {
		return
	}
	out := unsafe.Slice((*int16)(unsafe.Pointer(p)), int(n))
	if e := iosEngine.Load(); e != nil {
		e.Playback(out)
		return
	}
	clear(out)
}

// iosAudio is the voice-processing audio unit (voice_device_ios.m): echo
// cancelled, in a voice-chat audio session that keeps running in the
// background (UIBackgroundModes audio).
type iosAudio struct {
	mu      sync.Mutex
	speaker bool
}

func openAudioDevice() (audioDevice, error) { return &iosAudio{speaker: true}, nil }

func micPermission(request bool) micAccess { return micpermAccess(request) }

// The route is the system's (headsets take over); there's nothing to pick.
func (a *iosAudio) Inputs() ([]voice.DeviceInfo, error) {
	return []voice.DeviceInfo{{Name: "iPhone microphone", IsDefault: true}}, nil
}

func (a *iosAudio) Outputs() ([]voice.DeviceInfo, error) {
	return []voice.DeviceInfo{{Name: "iPhone audio", IsDefault: true}}, nil
}

func (a *iosAudio) Start(e *voice.Engine, _, _ string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	// Restarting on a new engine (a new VAD threshold) only swaps the
	// engine: the unit keeps running.
	if iosEngine.Swap(e) != nil {
		return nil
	}
	var what *C.char
	if st := C.bvStart(boolInt(a.speaker), &what); st != 0 {
		iosEngine.Store(nil)
		return fmt.Errorf("voice: couldn't %s (%d)", C.GoString(what), int(st))
	}
	return nil
}

func (a *iosAudio) Stop() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if iosEngine.Swap(nil) != nil {
		C.bvStop()
	}
}

func (a *iosAudio) Close() { a.Stop() }

func (a *iosAudio) SetSpeaker(on bool) {
	a.mu.Lock()
	a.speaker = on
	a.mu.Unlock()
	C.bvSetSpeaker(boolInt(on))
}

func (a *iosAudio) Route() string { return routeName(int(C.bvRoute())) }

func (a *iosAudio) Interrupted() bool { return C.bvInterrupted() != 0 }

func boolInt(b bool) C.int {
	if b {
		return 1
	}
	return 0
}
