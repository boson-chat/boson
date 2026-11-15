package main

import (
	"strings"
	"sync"
	"testing"

	"github.com/boson-chat/quicvoice/gen/controlpb"
)

// fakeCalls records what the OS hears about calls (Android's foreground
// service).
type fakeCalls struct {
	mu     sync.Mutex
	events []string
}

func (c *fakeCalls) CallStarted(room, server string) {
	c.mu.Lock()
	c.events = append(c.events, "start "+room+" "+server)
	c.mu.Unlock()
}

func (c *fakeCalls) CallEnded() {
	c.mu.Lock()
	c.events = append(c.events, "end")
	c.mu.Unlock()
}

func (c *fakeCalls) got() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.events, ", ")
}

// phoneAudio is a fakeAudio with a phone's speaker switch and route.
type phoneAudio struct {
	*fakeAudio
	speaker     []bool
	route       string
	interrupted bool
}

func (p *phoneAudio) SetSpeaker(on bool) {
	p.mu.Lock()
	p.speaker = append(p.speaker, on)
	p.mu.Unlock()
}

func (p *phoneAudio) Stats() audioStats {
	st := p.fakeAudio.Stats()
	p.mu.Lock()
	st.Route, st.Interrupted = p.route, p.interrupted
	p.mu.Unlock()
	return st
}

func TestVoiceCallNotifierFollowsTheCall(t *testing.T) {
	h := newVoiceHarness(t)
	calls := &fakeCalls{}
	h.svc.calls = calls

	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", RoomName: "General", Token: "tok"})
	if got := calls.got(); got != "start General irc.boson.chat" {
		t.Fatalf("after join: %q", got)
	}
	// The state loop's sync doesn't repeat it.
	h.svc.syncCall()
	h.svc.Leave()
	if got := calls.got(); got != "start General irc.boson.chat, end" {
		t.Fatalf("after leave: %q", got)
	}
	h.svc.Leave()
	if got := calls.got(); got != "start General irc.boson.chat, end" {
		t.Fatalf("leaving twice: %q", got)
	}
}

func TestVoiceCallNotifierNotWithoutTheMic(t *testing.T) {
	h := newVoiceHarness(t)
	calls := &fakeCalls{}
	h.svc.calls = calls
	h.mic = micDenied
	st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "tok"})
	if st.ErrorKind != "mic" {
		t.Fatalf("state: %+v", st)
	}
	// Android can't start a microphone service without the permission.
	if got := calls.got(); got != "" {
		t.Fatalf("told the OS about a call that never opened the mic: %q", got)
	}
}

func TestVoiceCallNotifierWhenDroppedOrKicked(t *testing.T) {
	h := newVoiceHarness(t)
	calls := &fakeCalls{}
	h.svc.calls = calls

	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "tok"})
	_ = h.conns[0].Close() // the server went away
	waitFor(t, func() bool { return h.svc.State().Status == "error" })
	h.svc.syncCall() // the state loop's tick
	if got := calls.got(); got != "start general irc.boson.chat, end" {
		t.Fatalf("after a drop: %q", got)
	}

	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "tok"})
	h.conns[1].onCtl(&controlpb.ControlMessage{Msg: &controlpb.ControlMessage_Error{
		Error: &controlpb.Error{Code: controlpb.Error_KICKED, Message: "room deleted"},
	}})
	waitFor(t, func() bool { return h.svc.State().ErrorKind == "kicked" })
	h.svc.syncCall()
	if got := calls.got(); !strings.HasSuffix(got, "start general irc.boson.chat, end") || strings.Count(got, "end") != 2 {
		t.Fatalf("after a kick: %q", got)
	}
}

func TestVoiceSpeakerAndRoute(t *testing.T) {
	h := newVoiceHarness(t)
	p := &phoneAudio{fakeAudio: h.audio, route: "speaker"}
	h.svc.newAudio = func() (audioBackend, error) { return p, nil }

	// Speaker by default, applied when the device opens.
	st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "tok"})
	if !st.Speaker || st.Route != "speaker" || st.Interrupted {
		t.Fatalf("state: %+v", st)
	}
	if len(p.speaker) != 1 || !p.speaker[0] {
		t.Fatalf("speaker not applied on open: %v", p.speaker)
	}

	p.mu.Lock()
	p.route, p.interrupted = "earpiece", true
	p.mu.Unlock()
	st = h.svc.SetSpeaker(false)
	if st.Speaker || st.Route != "earpiece" || !st.Interrupted {
		t.Fatalf("after SetSpeaker(false): %+v", st)
	}
	if len(p.speaker) != 2 || p.speaker[1] {
		t.Fatalf("speaker switch: %v", p.speaker)
	}

	// No route once the device is closed.
	h.svc.Leave()
	if st := h.svc.State(); st.Route != "" || st.Interrupted || st.Speaker {
		t.Fatalf("after leave: %+v", st)
	}
}

func TestVoiceSpeakerOnDesktopIsHarmless(t *testing.T) {
	h := newVoiceHarness(t)
	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "tok"})
	if st := h.svc.SetSpeaker(false); st.Status != "connected" || st.Route != "" {
		t.Fatalf("state: %+v", st)
	}
}

func TestMicDeniedMessage(t *testing.T) {
	for goos, want := range map[string]string{
		"ios":     "Settings",
		"android": "Settings → Apps → Boson",
		"darwin":  "privacy settings",
		"windows": "privacy settings",
	} {
		if got := micDeniedMessage(goos); !strings.Contains(got, want) || !strings.HasPrefix(got, "Boson can't use your microphone.") {
			t.Errorf("%s: %q", goos, got)
		}
	}
}

func TestRouteName(t *testing.T) {
	for code, want := range map[int]string{0: "", 1: "speaker", 2: "earpiece", 3: "headphones", 4: "bluetooth", 5: "other", 99: ""} {
		if got := routeName(code); got != want {
			t.Errorf("routeName(%d) = %q, want %q", code, got, want)
		}
	}
}
