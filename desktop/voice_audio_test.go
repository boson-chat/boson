//go:build cgo && !novoiceaudio

package main

import (
	"sync"
	"testing"

	"github.com/boson-chat/quicvoice/client/voice"
)

// fakeDevice stands in for a phone's audio device (voice_device_ios.go,
// voice_device_android.go) under quicvoiceAudio.
type fakeDevice struct {
	mu      sync.Mutex
	engines []*voice.Engine
	stops   int
	closed  bool
	speaker []bool
}

func (d *fakeDevice) Start(e *voice.Engine, _, _ string) error {
	d.mu.Lock()
	d.engines = append(d.engines, e)
	d.mu.Unlock()
	return nil
}
func (d *fakeDevice) Stop()  { d.mu.Lock(); d.stops++; d.mu.Unlock() }
func (d *fakeDevice) Close() { d.mu.Lock(); d.closed = true; d.mu.Unlock() }
func (d *fakeDevice) Inputs() ([]voice.DeviceInfo, error) {
	return []voice.DeviceInfo{{Name: "mic", IsDefault: true}}, nil
}
func (d *fakeDevice) Outputs() ([]voice.DeviceInfo, error) { return nil, nil }
func (d *fakeDevice) SetSpeaker(on bool) {
	d.mu.Lock()
	d.speaker = append(d.speaker, on)
	d.mu.Unlock()
}
func (d *fakeDevice) Route() string     { return "bluetooth" }
func (d *fakeDevice) Interrupted() bool { return true }

func newTestAudio(t *testing.T, dev audioDevice) *quicvoiceAudio {
	t.Helper()
	q := &quicvoiceAudio{dev: dev, gains: map[uint16]float32{}, threshold: 0.25}
	eng, err := q.newEngine()
	if err != nil {
		t.Fatal(err)
	}
	q.eng.Store(eng)
	t.Cleanup(q.Close)
	return q
}

func TestQuicvoiceAudioOnAPhoneDevice(t *testing.T) {
	dev := &fakeDevice{}
	q := newTestAudio(t, dev)
	if err := q.Start("", ""); err != nil {
		t.Fatal(err)
	}
	q.SetSpeaker(false)
	if len(dev.speaker) != 1 || dev.speaker[0] {
		t.Errorf("speaker not passed on: %v", dev.speaker)
	}
	st := q.Stats()
	if st.Route != "bluetooth" || !st.Interrupted {
		t.Errorf("phone stats: %+v", st)
	}

	// A new VAD threshold makes a new engine and hands it to the running
	// device (the iOS unit swaps engines without restarting).
	first := q.eng.Load()
	q.SetVADThreshold(0.5)
	if q.eng.Load() == first || len(dev.engines) != 2 || dev.engines[1] != q.eng.Load() {
		t.Fatalf("engine not swapped onto the device: %d starts", len(dev.engines))
	}
	q.Stop()
	if dev.stops != 1 {
		t.Errorf("stops: %d", dev.stops)
	}
}

func TestQuicvoiceAudioDesktopDeviceHasNoRoute(t *testing.T) {
	q := newTestAudio(t, plainDevice{})
	q.SetSpeaker(true) // nothing to do, nothing breaks
	if st := q.Stats(); st.Route != "" || st.Interrupted {
		t.Errorf("desktop stats: %+v", st)
	}
}

// plainDevice is only an audioDevice.
type plainDevice struct{}

func (plainDevice) Start(*voice.Engine, string, string) error { return nil }
func (plainDevice) Stop()                                     {}
func (plainDevice) Close()                                    {}
func (plainDevice) Inputs() ([]voice.DeviceInfo, error)       { return nil, nil }
func (plainDevice) Outputs() ([]voice.DeviceInfo, error)      { return nil, nil }

// The voice quality applies to the running engine and survives a new
// engine (a VAD threshold change).
func TestQuicvoiceAudioQuality(t *testing.T) {
	q := newTestAudio(t, plainDevice{})
	if b := q.eng.Load().Bitrate(); b != voiceBitrate {
		t.Fatalf("default bitrate %d", b)
	}
	q.SetQuality(128000, true)
	if b := q.eng.Load().Bitrate(); b != 128000 {
		t.Fatalf("bitrate %d", b)
	}
	q.SetVADThreshold(0.5)
	if b := q.eng.Load().Bitrate(); b != 128000 {
		t.Fatalf("new engine lost the quality: %d", b)
	}
}
