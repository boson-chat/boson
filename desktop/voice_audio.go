//go:build cgo && !novoiceaudio && !ios && !android

package main

import (
	"errors"
	"sync"
	"sync/atomic"

	"github.com/boson-chat/boson/desktop/internal/micperm"
	"github.com/boson-chat/quicvoice/client/voice"
	"github.com/boson-chat/quicvoice/wire"
)

// Voice audio: the quicvoice engine (capture, VAD/push-to-talk, Opus,
// jitter buffers, mixer) on a miniaudio duplex device. cgo: libopus (built
// with -tags nolibopusfile; only libopus is linked) and miniaudio.
const voiceAudioCompiled = true

var errVoiceAudioUnavailable = errors.New("voice audio is unavailable")

func newAudioBackend() (audioBackend, error) {
	dev, err := voice.NewAudio()
	if err != nil {
		return nil, err
	}
	q := &quicvoiceAudio{dev: dev, gains: map[uint16]float32{}, threshold: 0.25}
	eng, err := q.newEngine()
	if err != nil {
		dev.Close()
		return nil, err
	}
	q.eng.Store(eng)
	return q, nil
}

func micPermission(request bool) micAccess {
	switch micperm.Status() {
	case micperm.Granted:
		return micGranted
	case micperm.Denied:
		return micDenied
	default:
		if request && micperm.Request() {
			return micGranted
		} else if request {
			return micDenied
		}
		return micUndetermined
	}
}

// quicvoiceAudio adapts voice.Audio + voice.Engine. The engine takes its
// VAD threshold only when it's made, so changing it makes a new engine with
// every setting carried over.
type quicvoiceAudio struct {
	dev *voice.Audio
	eng atomic.Pointer[voice.Engine]

	mu                            sync.Mutex
	running                       bool
	in, out                       string
	ptt, pttDown, muted, deafened bool
	loopback                      bool
	gains                         map[uint16]float32
	sender                        voiceSender
	threshold                     float32
}

func (q *quicvoiceAudio) newEngine() (*voice.Engine, error) {
	return voice.NewEngine(voice.Options{VADThreshold: max(q.threshold, 0.001)})
}

func (q *quicvoiceAudio) Start(in, out string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if err := q.dev.Start(q.eng.Load(), in, out); err != nil {
		q.running = false
		return err
	}
	q.running, q.in, q.out = true, in, out
	return nil
}

func (q *quicvoiceAudio) Stop() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.dev.Stop()
	q.running = false
}

func (q *quicvoiceAudio) Devices() (in, out []VoiceDevice, err error) {
	conv := func(ds []voice.DeviceInfo) []VoiceDevice {
		r := make([]VoiceDevice, 0, len(ds))
		for _, d := range ds {
			r = append(r, VoiceDevice{ID: d.ID, Name: d.Name, IsDefault: d.IsDefault})
		}
		return r
	}
	i, err := q.dev.Inputs()
	if err != nil {
		return nil, nil, err
	}
	o, err := q.dev.Outputs()
	if err != nil {
		return nil, nil, err
	}
	return conv(i), conv(o), nil
}

func (q *quicvoiceAudio) HandleAudio(d wire.Downlink) { q.eng.Load().HandleAudio(d) }
func (q *quicvoiceAudio) RemoveSender(sid uint16)     { q.eng.Load().RemoveSender(sid) }

func (q *quicvoiceAudio) SetSender(s voiceSender) {
	q.mu.Lock()
	q.sender = s
	q.mu.Unlock()
	if s == nil {
		q.eng.Load().SetSender(nil)
		return
	}
	q.eng.Load().SetSender(s)
}

func (q *quicvoiceAudio) SetPushToTalk(on bool) {
	q.mu.Lock()
	q.ptt = on
	q.mu.Unlock()
	mode := voice.ModeVoiceActivity
	if on {
		mode = voice.ModePushToTalk
	}
	q.eng.Load().SetMode(mode)
}

func (q *quicvoiceAudio) SetPTT(down bool) {
	q.mu.Lock()
	q.pttDown = down
	q.mu.Unlock()
	q.eng.Load().SetPTT(down)
}

func (q *quicvoiceAudio) SetMuted(m bool) {
	q.mu.Lock()
	q.muted = m
	q.mu.Unlock()
	q.eng.Load().SetMuted(m)
}

func (q *quicvoiceAudio) SetDeafened(d bool) {
	q.mu.Lock()
	q.deafened = d
	q.mu.Unlock()
	q.eng.Load().SetDeafened(d)
}

func (q *quicvoiceAudio) SetLoopback(on bool) {
	q.mu.Lock()
	q.loopback = on
	q.mu.Unlock()
	q.eng.Load().SetLoopback(on)
}

func (q *quicvoiceAudio) SetUserVolume(sid uint16, gain float32) {
	q.mu.Lock()
	q.gains[sid] = gain
	q.mu.Unlock()
	q.eng.Load().SetUserVolume(sid, gain)
}

func (q *quicvoiceAudio) SetVADThreshold(unit float32) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if unit == q.threshold {
		return
	}
	q.threshold = unit
	eng, err := q.newEngine()
	if err != nil {
		return
	}
	eng.SetMode(map[bool]voice.Mode{false: voice.ModeVoiceActivity, true: voice.ModePushToTalk}[q.ptt])
	eng.SetPTT(q.pttDown)
	eng.SetMuted(q.muted)
	eng.SetDeafened(q.deafened)
	eng.SetLoopback(q.loopback)
	for sid, g := range q.gains {
		eng.SetUserVolume(sid, g)
	}
	if q.sender != nil {
		eng.SetSender(q.sender)
	}
	old := q.eng.Swap(eng)
	old.SetSender(nil)
	if q.running {
		// The device callback holds the engine: reopen it on the new one.
		if err := q.dev.Start(eng, q.in, q.out); err != nil {
			q.running = false
		}
	}
	old.Close()
}

func (q *quicvoiceAudio) Stats() audioStats {
	es := q.eng.Load().Stats()
	st := audioStats{MicLevel: es.MicLevel, Transmitting: es.Transmitting, Speaking: map[uint16]bool{}}
	var played, concealed uint64
	for _, snd := range es.Senders {
		st.Speaking[snd.SessionID] = snd.Speaking
		played += snd.Jitter.Played
		concealed += snd.Jitter.Concealed
	}
	if total := played + concealed; total > 0 {
		st.LossPercent = 100 * float32(concealed) / float32(total)
	}
	return st
}

func (q *quicvoiceAudio) Close() {
	q.dev.Close()
	q.eng.Load().Close()
}
