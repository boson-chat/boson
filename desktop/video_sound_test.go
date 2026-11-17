package main

import (
	"runtime"
	"slices"
	"sync"
	"testing"
	"time"

	qvclient "github.com/boson-chat/quicvideo/client"
	videopb "github.com/boson-chat/quicvideo/gen/controlpb"
)

// fakeSoundPlayer is the voice engine's side of a share's sound.
type fakeSoundPlayer struct {
	mu      sync.Mutex
	played  []playedSound
	removed []uint32
	gains   map[uint32]float32
	delays  map[uint32]time.Duration
	offset  int64
	playing bool
}

type playedSound struct {
	track uint32
	us    uint64
	gain  float32
}

func (p *fakeSoundPlayer) playShareSound(track uint32, us uint64, _ []byte, gain float32) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.played = append(p.played, playedSound{track, us, gain})
	p.playing = true
}
func (p *fakeSoundPlayer) removeShareSound(track uint32) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.removed = append(p.removed, track)
	p.playing = false
}
func (p *fakeSoundPlayer) setShareSoundGain(track uint32, g float32) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gains[track] = g
}
func (p *fakeSoundPlayer) shareSoundOffset(uint32) (int64, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.offset, p.playing
}
func (p *fakeSoundPlayer) setShareSoundDelay(track uint32, d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.delays[track] = d
}

// A screen share's sound: asked for with the share, where it can be sent;
// heard while watching the share (through the voice engine), at its own
// volume; and the share's picture keeps to its sound, not the sharer's
// voice.
func TestVideoScreenSound(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("Linux has the system's picker: no app picker, no sound toggle")
	}
	h := newVideoHarness(t)
	snd := &fakeSoundPlayer{gains: map[uint32]float32{}, delays: map[uint32]time.Duration{}, offset: 120_000}
	h.svc.sounds = snd
	h.media.canSound = true
	now := time.Unix(1_800_000_000, 0)
	h.svc.now = func() time.Time { return now }
	h.join(t, `"video.publish"`)
	if !slices.Contains(h.opts[0].Capabilities, qvclient.CapScreenAudio) {
		t.Fatalf("Hello capabilities %v", h.opts[0].Capabilities)
	}
	if !h.svc.State().CanShareAudio {
		t.Fatal("can't share sound")
	}

	// Sending: the share asks the media for its sound.
	h.svc.ShareScreen(true, "display:1", "motion", true)
	waitUntil(t, "sharing", func() bool { return h.svc.State().Screen.On })
	h.media.mu.Lock()
	asked := h.media.sounds
	h.media.mu.Unlock()
	if len(asked) != 1 || !asked[0] {
		t.Fatalf("StartScreen sound %v", asked)
	}
	h.svc.SetScreen(false, "")
	h.svc.SetScreen(true, "display:1") // the plain way: no sound
	waitUntil(t, "sharing again", func() bool { return h.svc.State().Screen.On })
	h.media.mu.Lock()
	asked = h.media.sounds
	h.media.mu.Unlock()
	if asked[len(asked)-1] {
		t.Fatal("a share without the toggle asked for sound")
	}

	// alice shares her screen with its sound.
	c := h.conn(0)
	c.events <- &videopb.ControlMessage{Msg: &videopb.ControlMessage_TrackAdded{TrackAdded: &videopb.TrackAdded{
		Track: &videopb.Track{TrackId: 14, SessionId: 2, Kind: videopb.TrackKind_SCREEN, Layers: []*videopb.Layer{{Id: 0, Width: 1920, Height: 1080, Fps: 30}}}}}}
	c.events <- &videopb.ControlMessage{Msg: &videopb.ControlMessage_TrackAdded{TrackAdded: &videopb.TrackAdded{
		Track: &videopb.Track{TrackId: 15, SessionId: 2, Kind: videopb.TrackKind_SCREEN_AUDIO, ForTrackId: 14, Layers: []*videopb.Layer{{Id: 0}}}}}}
	waitUntil(t, "alice's share", func() bool { return len(h.svc.State().Tracks) == 2 })
	st := h.svc.State()
	for _, tr := range st.Tracks {
		if tr.TrackID == 15 {
			t.Fatal("the sound track is a tile")
		}
		if tr.TrackID == 14 && (!tr.Sound || tr.Volume != 100) {
			t.Fatalf("alice's share %+v", tr)
		}
	}

	// Watching it: hearing it.
	h.svc.Subscribe(14, 0)
	waitUntil(t, "subscribed to the sound", func() bool { c.mu.Lock(); defer c.mu.Unlock(); _, ok := c.subs[15]; return ok })
	h.svc.onFrame(qvclient.RemoteFrame{TrackID: 15, CaptureUS: 1000, Payload: []byte{1}})
	h.svc.SetShareVolume(14, 0)
	h.svc.onFrame(qvclient.RemoteFrame{TrackID: 15, CaptureUS: 21000, Payload: []byte{2}})
	snd.mu.Lock()
	if len(snd.played) != 2 || snd.played[0].gain != 1 || snd.played[1].gain != 0 || snd.gains[15] != 0 {
		t.Fatalf("played %+v, gains %v", snd.played, snd.gains)
	}
	snd.mu.Unlock()
	if v := trackByID(h.svc.State(), 14).Volume; v != 0 {
		t.Fatalf("volume %d, want 0 (muted)", v)
	}

	// The share's picture follows its sound's offset, and a late picture
	// delays the sound, never alice's voice.
	voiceDelays := map[string]time.Duration{}
	h.svc.audioDelay = func(u string, d time.Duration) { voiceDelays[u] = d }
	h.svc.offsets = func() map[string]int64 { return map[string]int64{"usr_alice": 80_000} }
	if _, err := h.svc.frames(); err != nil {
		t.Fatal(err)
	}
	h.svc.mu.Lock()
	sess := h.svc.sess
	h.svc.mu.Unlock()
	h.svc.sendSync(sess)
	if offs := h.svc.soundOffs.Load(); offs == nil || (*offs)[14] != 120_000 {
		t.Fatalf("share offsets %v", offs)
	}
	for range 10 {
		h.svc.noteLateness(14, uint64(now.UnixMicro()-120_000-(40*time.Millisecond-videoDecodeBudget).Microseconds()))
	}
	now = now.Add(adaptEvery)
	h.svc.adaptDelays()
	snd.mu.Lock()
	d := snd.delays[15]
	snd.mu.Unlock()
	if d != 50*time.Millisecond || len(voiceDelays) != 0 {
		t.Fatalf("sound delay %v, voice delays %v", d, voiceDelays)
	}

	// Not watching any more: not hearing it.
	h.svc.Unsubscribe(14)
	snd.mu.Lock()
	removed := slices.Contains(snd.removed, 15)
	snd.mu.Unlock()
	c.mu.Lock()
	_, still := c.subs[15]
	c.mu.Unlock()
	if !removed || still {
		t.Fatalf("after unsubscribing: removed %v, still subscribed %v", removed, still)
	}
}

// A server without screen-audio (older quicvideod): no "Share sound".
func TestVideoScreenSoundNeedsServer(t *testing.T) {
	h := newVideoHarness(t)
	h.media.canSound = true
	h.join(t, `"video.publish"`)
	if h.svc.State().CanShareAudio {
		t.Fatal("sound offered without a player")
	}
	if len(h.opts[0].Capabilities) != 0 {
		t.Fatalf("asked for sound it can't play: %v", h.opts[0].Capabilities)
	}
}

func trackByID(st VideoState, id int) VideoTrack {
	for _, tr := range st.Tracks {
		if tr.TrackID == id {
			return tr
		}
	}
	return VideoTrack{}
}
