//go:build android && cgo && !novoiceaudio

package main

import (
	"fmt"
	"sync"
	"unsafe"

	"github.com/boson-chat/quicvoice/client/voice"
	"github.com/gen2brain/malgo"
)

// Android: a phone's data plan, so a little under desktop's 32 kbit/s
// (Opus voice stays clear well below that).
const voiceBitrate = 24000

// androidAudio is miniaudio on AAudio (OpenSL ES on Android 8.0, which has
// no AAudio) as a voice call: the voice-communication usage and input
// preset, so the platform's echo canceller and noise suppressor run on the
// mic where the device has them, and the output follows the call routing
// (earpiece, loudspeaker, headset) that BosonVoice sets with
// MODE_IN_COMMUNICATION. miniaudio reopens the streams itself after a
// route change.
type androidAudio struct {
	ctx *malgo.AllocatedContext

	mu  sync.Mutex
	dev *malgo.Device
}

func openAudioDevice() (audioDevice, error) {
	ctx, err := malgo.InitContext([]malgo.Backend{malgo.BackendAaudio, malgo.BackendOpensl}, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, fmt.Errorf("voice: init audio: %w", err)
	}
	return &androidAudio{ctx: ctx}, nil
}

// One device each way: the system picks it from the call routing.
func (a *androidAudio) Inputs() ([]voice.DeviceInfo, error) {
	return []voice.DeviceInfo{{Name: "Phone microphone", IsDefault: true}}, nil
}

func (a *androidAudio) Outputs() ([]voice.DeviceInfo, error) {
	return []voice.DeviceInfo{{Name: "Phone audio", IsDefault: true}}, nil
}

func (a *androidAudio) Start(e *voice.Engine, _, _ string) error {
	a.Stop()
	// The call audio mode and audio focus first: AAudio picks its route
	// when the streams open.
	javaVoidInt("audioStarted", 1)

	cfg := malgo.DefaultDeviceConfig(malgo.Duplex)
	cfg.SampleRate = voice.SampleRate
	cfg.PeriodSizeInFrames = voice.FrameSamples / 2 // 10 ms callbacks
	cfg.Capture.Format = malgo.FormatS16
	cfg.Capture.Channels = 1
	cfg.Playback.Format = malgo.FormatS16
	cfg.Playback.Channels = 1
	cfg.AAudio.Usage = malgo.AAudioUsageVoiceCommunication
	cfg.AAudio.ContentType = malgo.AAudioContentTypeSpeech
	cfg.AAudio.InputPreset = malgo.AAudioInputPresetVoiceCommunication

	dev, err := malgo.InitDevice(a.ctx.Context, cfg, malgo.DeviceCallbacks{
		Data: func(out, in []byte, frames uint32) {
			if len(in) >= 2 {
				e.Capture(int16s(in))
			}
			if len(out) >= 2 {
				e.Playback(int16s(out))
			}
		},
	})
	if err != nil {
		javaVoidInt("audioStarted", 0)
		return fmt.Errorf("voice: open device: %w", err)
	}
	if err := dev.Start(); err != nil {
		dev.Uninit()
		javaVoidInt("audioStarted", 0)
		return fmt.Errorf("voice: start device: %w", err)
	}
	a.mu.Lock()
	a.dev = dev
	a.mu.Unlock()
	return nil
}

func (a *androidAudio) Stop() {
	a.mu.Lock()
	dev := a.dev
	a.dev = nil
	a.mu.Unlock()
	if dev != nil {
		_ = dev.Stop()
		dev.Uninit()
		javaVoidInt("audioStarted", 0)
	}
}

func (a *androidAudio) Close() {
	a.Stop()
	_ = a.ctx.Uninit()
	a.ctx.Free()
}

func (a *androidAudio) SetSpeaker(on bool) {
	v := 0
	if on {
		v = 1
	}
	javaVoidInt("setSpeaker", v)
}

// Route: BosonVoice.route's code (routeName).
func (a *androidAudio) Route() string { return routeName(javaInt("route", "(I)I", 0)) }

func (a *androidAudio) Interrupted() bool { return javaInt("interrupted", "(I)I", 0) == 1 }

// int16s views little-endian S16 bytes as samples without copying.
func int16s(b []byte) []int16 {
	return unsafe.Slice((*int16)(unsafe.Pointer(unsafe.SliceData(b))), len(b)/2)
}
