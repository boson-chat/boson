package main

import (
	"sync"
	"testing"

	"github.com/boson-chat/quicvoice/gen/controlpb"
)

type hookLog struct {
	mu            sync.Mutex
	joined, left  int
	lastConnTyped bool
}

func (h *hookLog) voiceJoined(c voiceConn) {
	h.mu.Lock()
	h.joined++
	_, h.lastConnTyped = c.(*fakeConn)
	h.mu.Unlock()
}
func (h *hookLog) voiceLeft() { h.mu.Lock(); h.left++; h.mu.Unlock() }
func (h *hookLog) counts() (int, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.joined, h.left
}

// The call's video hears about every start and every end: leave, kick and
// a dropped connection.
func TestVoiceTellsVideo(t *testing.T) {
	for name, end := range map[string]func(h *voiceHarness){
		"leave": func(h *voiceHarness) { h.svc.Leave() },
		"kick": func(h *voiceHarness) {
			h.conns[0].onCtl(&controlpb.ControlMessage{Msg: &controlpb.ControlMessage_Error{Error: &controlpb.Error{
				Code: controlpb.Error_KICKED, Message: "the channel was deleted"}}})
		},
		"drop": func(h *voiceHarness) { _ = h.conns[0].Close() },
	} {
		t.Run(name, func(t *testing.T) {
			h := newVoiceHarness(t)
			hooks := &hookLog{}
			h.svc.video = hooks
			h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "tok"})
			if j, _ := hooks.counts(); j != 1 || !hooks.lastConnTyped {
				t.Fatalf("joined %d", j)
			}
			end(h)
			waitUntil(t, "video told", func() bool { _, l := hooks.counts(); return l >= 1 })
		})
	}
}

// playoutAudio is a backend whose engine reports playout (lip sync).
type playoutAudio struct {
	*fakeAudio
	ts      uint32
	localUS int64
	ok      bool
}

func (p *playoutAudio) Playout(uint16) (uint32, int64, bool) { return p.ts, p.localUS, p.ok }

// Lip sync: another member's AudioClock reports + our playout give the
// offset at which their video frames should show.
func TestVoiceAVOffsets(t *testing.T) {
	h := newVoiceHarness(t)
	pa := &playoutAudio{fakeAudio: h.audio}
	h.svc.newAudio = func() (audioBackend, error) { return pa, nil }
	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "tok"})
	if got := h.svc.avOffsets(); len(got) != 0 {
		t.Fatalf("offsets before any report: %v", got)
	}

	// alice (session 7): timestamp 1000 was captured at her wall clock T.
	const T = int64(1_800_000_000_000_000)
	report := func(sid uint32, ts uint32, us int64) {
		h.conns[0].onCtl(&controlpb.ControlMessage{Msg: &controlpb.ControlMessage_AudioClock{AudioClock: &controlpb.AudioClock{
			SessionId: sid, Timestamp: ts, CaptureUs: us, Version: 1}}})
	}
	report(7, 1000, T)
	report(99, 5, 5) // not a member: ignored

	// Our speaker plays her timestamp 1000+48000 (1 s later on her clock)
	// at our local time L: her frames captured at C show at C + (L - (T+1s)).
	const L = int64(1_800_000_000_500_000)
	pa.ts, pa.localUS, pa.ok = 1000+48000, L, true
	got := h.svc.avOffsets()
	if len(got) != 1 || got["usr_alice"] != L-(T+1_000_000) {
		t.Fatalf("offsets %v, want usr_alice: %d", got, L-(T+1_000_000))
	}

	// Silent (nothing of hers playing): no offset.
	pa.ok = false
	if got := h.svc.avOffsets(); len(got) != 0 {
		t.Fatalf("offsets while silent: %v", got)
	}

	// She leaves: her clock is dropped.
	h.conns[0].onCtl(&controlpb.ControlMessage{Msg: &controlpb.ControlMessage_ParticipantLeft{ParticipantLeft: &controlpb.ParticipantLeft{SessionId: 7}}})
	pa.ok = true
	if got := h.svc.avOffsets(); len(got) != 0 {
		t.Fatalf("offsets after she left: %v", got)
	}
}
