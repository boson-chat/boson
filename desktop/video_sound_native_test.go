//go:build cgo && !server && (darwin || windows || android || (linux && videocapture))

package main

import (
	"math"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/boson-chat/quicvoice/client/voice"
	"github.com/boson-chat/quicvoice/wire"
	"gopkg.in/hraban/opus.v2"
)

type fakeSoundTrack struct {
	mu       sync.Mutex
	frames   []soundFrameRec
	kf       chan uint32
	refuse   bool
	unpubbed bool
}

type soundFrameRec struct {
	key     bool
	us      uint64
	payload []byte
}

func (t *fakeSoundTrack) WriteFrame(_ uint32, key bool, us uint64, p []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.refuse {
		return errLayerInactiveTest
	}
	t.frames = append(t.frames, soundFrameRec{key, us, p})
	return nil
}
func (t *fakeSoundTrack) KeyframeRequests() <-chan uint32 { return t.kf }
func (t *fakeSoundTrack) Unpublish() error                { t.mu.Lock(); t.unpubbed = true; t.mu.Unlock(); return nil }
func (t *fakeSoundTrack) got() []soundFrameRec {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]soundFrameRec(nil), t.frames...)
}

var errLayerInactiveTest = &testErr{"inactive"}

type testErr struct{ s string }

func (e *testErr) Error() string { return e.s }

// feed sends a 440 Hz tone, in uneven buffers, stamped like the capture.
func feed(s *screenSound, startUS int64, seconds float64) {
	total := int(seconds * 48000)
	sizes := []int{1024, 480, 2048, 333}
	for pos, i := 0, 0; pos < total; i++ {
		n := min(sizes[i%len(sizes)], total-pos)
		buf := make([]float32, n)
		for k := range buf {
			buf[k] = float32(0.5 * math.Sin(2*math.Pi*440*float64(pos+k)/48000))
		}
		s.capture(buf, startUS+int64(pos)*1_000_000/48000)
		pos += n
		time.Sleep(time.Millisecond) // like buffers arriving; the queue stays short
	}
}

func waitFrames(t *testing.T, tr *fakeSoundTrack, n int) []soundFrameRec {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if f := tr.got(); len(f) >= n {
			return f
		}
		time.Sleep(5 * time.Millisecond)
	}
	f := tr.got()
	t.Fatalf("%d frames, want %d", len(f), n)
	return f
}

func TestScreenSoundFrames(t *testing.T) {
	s, err := newScreenSound()
	if err != nil {
		t.Fatal(err)
	}
	tr := &fakeSoundTrack{kf: make(chan uint32, 4)}
	s.use(tr)
	start := time.Now().UnixMicro()
	feed(s, start, 1.0)
	frames := waitFrames(t, tr, 50)

	dec, err := opus.NewDecoder(48000, 1)
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]float32, soundFrame)
	var energy float64
	for i, f := range frames[:50] {
		if want := uint64(start + int64(i)*soundFrameUS); f.us != want {
			t.Fatalf("frame %d stamped %d µs off", i, int64(f.us)-int64(want))
		}
		if f.key != (i%soundGroup == 0) {
			t.Fatalf("frame %d keyframe %v", i, f.key)
		}
		n, err := dec.DecodeFloat32(f.payload, pcm)
		if err != nil || n != soundFrame {
			t.Fatalf("frame %d: decoded %d samples: %v", i, n, err)
		}
		if i >= 5 {
			for _, v := range pcm {
				energy += float64(v * v)
			}
		}
	}
	if rms := math.Sqrt(energy / float64(45*soundFrame)); rms < 0.25 || rms > 0.45 {
		t.Fatalf("decoded RMS %.3f, want the tone's ~0.35", rms)
	}

	// A jump in the capture clock (a new source): the count restarts there,
	// on a keyframe.
	jump := start + 5_000_000
	feed(s, jump, 0.2)
	frames = waitFrames(t, tr, 60)
	if f := frames[50]; f.us != uint64(jump) || !f.key {
		t.Fatalf("after the jump: %d µs, key %v", int64(f.us)-jump, f.key)
	}

	// A keyframe request starts the next group early.
	tr.kf <- 0
	feed(s, jump+200_000, 0.1)
	frames = waitFrames(t, tr, 65)
	if !frames[60].key {
		t.Fatal("a keyframe request didn't start a group")
	}

	s.stop()
	if !tr.unpubbed {
		t.Fatal("stop didn't unpublish")
	}
}

// Nobody listening (the layer is inactive): frames are refused, and the
// first one taken once someone is starts a group.
func TestScreenSoundInactive(t *testing.T) {
	s, err := newScreenSound()
	if err != nil {
		t.Fatal(err)
	}
	defer s.stop()
	tr := &fakeSoundTrack{kf: make(chan uint32, 4), refuse: true}
	s.use(tr)
	start := time.Now().UnixMicro()
	feed(s, start, 0.1)
	time.Sleep(50 * time.Millisecond)
	tr.mu.Lock()
	tr.refuse = false
	tr.mu.Unlock()
	feed(s, start+100_000, 0.1)
	frames := waitFrames(t, tr, 3)
	if !frames[0].key {
		t.Fatal("the first frame after a refusal isn't a keyframe")
	}
}

// engineAudio is the real quicvoice engine behind the audioBackend calls a
// share's sound uses.
type engineAudio struct {
	*fakeAudio
	e *voice.Engine
}

func (a *engineAudio) HandleAudio(d wire.Downlink)         { a.e.HandleAudio(d) }
func (a *engineAudio) SetUserVolume(sid uint16, g float32) { a.e.SetUserVolume(sid, g) }
func (a *engineAudio) RemoveSender(sid uint16)             { a.e.RemoveSender(sid) }
func (a *engineAudio) Playout(sid uint16) (uint32, int64, bool) {
	return a.e.Playout(sid)
}

// End to end through the real pieces, in real time: the sharer's encoder
// → (the relay keeps frames and capture times) → the viewer's voice
// engine, which plays the shared tone, and whose playout gives the
// picture's lip-sync offset (a little after capture: the jitter buffer).
func TestScreenSoundThroughVoiceEngine(t *testing.T) {
	enc, err := newScreenSound()
	if err != nil {
		t.Fatal(err)
	}
	defer enc.stop()
	tr := &fakeSoundTrack{kf: make(chan uint32, 4)}
	enc.use(tr)
	eng, err := voice.NewEngine(voice.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer eng.Close()
	s := &VoiceService{audio: &engineAudio{fakeAudio: &fakeAudio{volumes: map[uint16]float32{}}, e: eng},
		sess: &voiceSession{members: map[uint16]*voiceMember{1: {userID: "me"}}}}

	start := time.Now()
	var played []int16
	var offsets []int64
	sent := 0
	buf := make([]int16, voice.FrameSamples)
	for tick := 0; tick < 60; tick++ { // 1.2 s, 20 ms at a time
		at := start.Add(time.Duration(tick) * 20 * time.Millisecond)
		time.Sleep(time.Until(at))
		if tick < 50 {
			// 20 ms of tone captured now.
			pcm := make([]float32, soundFrame)
			for k := range pcm {
				pcm[k] = float32(0.5 * math.Sin(2*math.Pi*440*float64(tick*soundFrame+k)/48000))
			}
			enc.capture(pcm, at.UnixMicro())
		}
		// The relay delivers whatever the encoder sent (20 ms of network).
		frames := tr.got()
		for ; sent < len(frames); sent++ {
			s.playShareSound(15, frames[sent].us, frames[sent].payload, 1)
		}
		eng.Playback(buf)
		played = append(played, buf...)
		if off, ok := s.shareSoundOffset(15); ok {
			offsets = append(offsets, off)
		}
	}
	// The tone, after the jitter buffer filled.
	var energy float64
	var n int
	for _, v := range played[20*soundFrame : 45*soundFrame] {
		f := float64(v) / 32768
		energy += f * f
		n++
	}
	if rms := math.Sqrt(energy / float64(n)); rms < 0.2 || rms > 0.45 {
		t.Fatalf("played RMS %.3f, want the tone's ~0.35", rms)
	}
	if len(offsets) < 20 {
		t.Fatalf("only %d lip-sync offsets", len(offsets))
	}
	slices.Sort(offsets)
	med := offsets[len(offsets)/2]
	if med < 20_000 || med > 250_000 {
		t.Fatalf("pictures would show %d µs after capture, want the jitter buffer's ~60-100 ms", med)
	}
	t.Logf("sound plays %.0f ms after capture", float64(med)/1000)
}
