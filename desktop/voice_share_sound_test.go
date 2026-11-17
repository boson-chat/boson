package main

import (
	"sync"
	"testing"
	"time"

	"github.com/boson-chat/quicvoice/wire"
)

// soundAudio records what reaches the voice engine, and plays back a fixed
// timestamp (Playout).
type soundAudio struct {
	*fakeAudio
	mu     sync.Mutex
	got    []wire.Downlink
	delays map[uint16]time.Duration
	ts     uint32
	at     int64
}

func (a *soundAudio) HandleAudio(d wire.Downlink) {
	a.mu.Lock()
	a.got = append(a.got, d)
	a.mu.Unlock()
}
func (a *soundAudio) Playout(sid uint16) (uint32, int64, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ts, a.at, a.ts != 0
}
func (a *soundAudio) SetPlayoutDelay(sid uint16, d time.Duration) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.delays[sid] = d
}

// A share's sound in the voice engine: a stream id nobody in the call has,
// timestamps and sequence numbers from the capture clock (a dropped group
// is a gap, a pause a new spurt), its own gain and delay, and the picture's
// lip-sync offset from its playout.
func TestVoiceShareSound(t *testing.T) {
	a := &soundAudio{fakeAudio: &fakeAudio{volumes: map[uint16]float32{}}, delays: map[uint16]time.Duration{}}
	sess := &voiceSession{members: map[uint16]*voiceMember{1: {userID: "me"}, 0xFFFF: {userID: "unlucky"}}}
	s := &VoiceService{audio: a, sess: sess}

	const c0 = uint64(1_800_000_000_000_000) // capture µs
	s.playShareSound(15, c0, []byte{1}, 0.5)
	s.playShareSound(15, c0+20_000, []byte{2}, 0.5)
	s.playShareSound(15, c0+60_000, []byte{3}, 0.5)  // a dropped frame: a gap
	s.playShareSound(15, c0+400_000, []byte{4}, 0.5) // a pause: a new spurt
	s.playShareSound(16, c0, []byte{5}, 1)           // another share
	a.mu.Lock()
	got := append([]wire.Downlink(nil), a.got...)
	a.mu.Unlock()
	if len(got) != 5 {
		t.Fatalf("%d frames reached the engine", len(got))
	}
	sid := got[0].SessionID
	if sid == 0xFFFF || sid < shareSoundLastSID || got[4].SessionID == sid || got[4].SessionID == 0xFFFF {
		t.Fatalf("stream ids %#x and %#x (a member has 0xffff)", sid, got[4].SessionID)
	}
	for i, want := range []struct {
		dts, dseq uint32
		start     bool
	}{{0, 0, true}, {960, 1, false}, {2880, 3, false}, {19200, 20, true}} {
		d := got[i]
		if d.SessionID != sid || d.Timestamp-got[0].Timestamp != want.dts || uint32(d.Seq-got[0].Seq) != want.dseq ||
			(d.Flags&wire.FlagStart != 0) != want.start {
			t.Fatalf("frame %d: sid %#x, ts +%d, seq +%d, flags %b", i, d.SessionID, d.Timestamp-got[0].Timestamp, d.Seq-got[0].Seq, d.Flags)
		}
	}
	a.fakeAudio.mu.Lock()
	g := a.fakeAudio.volumes[sid]
	a.fakeAudio.mu.Unlock()
	if g != 0.5 {
		t.Fatalf("gain %v", g)
	}
	s.setShareSoundGain(15, 0)
	s.setShareSoundDelay(15, 30*time.Millisecond)
	a.fakeAudio.mu.Lock()
	g = a.fakeAudio.volumes[sid]
	a.fakeAudio.mu.Unlock()
	if g != 0 || a.delays[sid] != 30*time.Millisecond {
		t.Fatalf("gain %v, delay %v", g, a.delays[sid])
	}

	// The frame captured at c0+400 ms plays at local time L: pictures
	// captured at C show at C + (L - (c0+400 ms)).
	const local = int64(1_800_000_000_900_000)
	a.mu.Lock()
	a.ts, a.at = got[3].Timestamp, local
	a.mu.Unlock()
	off, ok := s.shareSoundOffset(15)
	want := local - int64(c0+400_000)
	if !ok || off < want-21 || off > want+21 { // within a 48 kHz sample
		t.Fatalf("offset %d, want %d", off, want)
	}

	s.removeShareSound(15)
	a.fakeAudio.mu.Lock()
	removed := len(a.fakeAudio.removed) > 0 && a.fakeAudio.removed[0] == sid
	g = a.fakeAudio.volumes[sid]
	a.fakeAudio.mu.Unlock()
	if !removed || g != 1 {
		t.Fatalf("removed %v, gain reset to %v", removed, g)
	}
	if _, ok := s.shareSoundOffset(15); ok {
		t.Fatal("an offset for a removed sound")
	}

	// Not in a call: nothing plays.
	s.mu.Lock()
	s.sess = nil
	s.mu.Unlock()
	s.playShareSound(17, c0, []byte{6}, 1)
	a.mu.Lock()
	n := len(a.got)
	a.mu.Unlock()
	if n != 5 {
		t.Fatal("played outside a call")
	}
}
