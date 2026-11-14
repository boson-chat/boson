//go:build !ios && !android

package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boson-chat/quicvoice/client"
	"github.com/boson-chat/quicvoice/gen/controlpb"
	"github.com/boson-chat/quicvoice/wire"
)

func TestVoiceDomain(t *testing.T) {
	cases := map[string]string{
		"irc.boson.chat":       "boson.chat",
		"IRC.Boson.Chat.":      "boson.chat",
		"boson.chat":           "boson.chat",
		"irc.ircforever.org":   "ircforever.org",
		"eu.irc.example.co.uk": "irc.example.co.uk",
		"localhost":            "",
		"127.0.0.1":            "",
		"::1":                  "",
		"":                     "",
		"a..b":                 "",
	}
	for in, want := range cases {
		if got := voiceDomain(in); got != want {
			t.Errorf("voiceDomain(%q) = %q, want %q", in, got, want)
		}
	}
}

const bosonJSON = `{"version":1,"irc":{"host":"irc.boson.chat","port":6697,"tls":true},"auth":{"url":"https://auth.boson.chat"},"voice":{"addr":"voice.boson.chat:7700","url":"https://voice.boson.chat/"}}`

func TestParseWellKnown(t *testing.T) {
	info, err := parseWellKnown([]byte(bosonJSON), false)
	if err != nil || info == nil {
		t.Fatalf("parse: %v %v", info, err)
	}
	if info.Addr != "voice.boson.chat:7700" || info.URL != "https://voice.boson.chat" || info.AuthURL != "https://auth.boson.chat" {
		t.Errorf("got %+v", info)
	}
	// Valid, without voice.
	if info, err := parseWellKnown([]byte(`{"version":1,"irc":{"host":"irc.x.org"}}`), false); info != nil || err != nil {
		t.Errorf("no voice: %v %v", info, err)
	}
	for _, bad := range []string{
		`not json`,
		`{"version":2,"voice":{"addr":"v.x:1","url":"https://v.x"},"auth":{"url":"https://a.x"}}`,
		`{"version":1,"voice":{"addr":"v.x:1","url":"https://v.x"}}`,
		`{"version":1,"voice":{"addr":"v.x","url":"https://v.x"},"auth":{"url":"https://a.x"}}`,
		`{"version":1,"voice":{"addr":"v.x:99999","url":"https://v.x"},"auth":{"url":"https://a.x"}}`,
		`{"version":1,"voice":{"addr":"v.x:1","url":"http://v.x"},"auth":{"url":"https://a.x"}}`,
		`{"version":1,"voice":{"addr":"v.x:1","url":"https://v.x"},"auth":{"url":"https://u:p@a.x"}}`,
	} {
		if _, err := parseWellKnown([]byte(bad), false); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	// Dev builds may use http (a local stack).
	if _, err := parseWellKnown([]byte(`{"version":1,"voice":{"addr":"127.0.0.1:7700","url":"http://127.0.0.1:7701"},"auth":{"url":"http://localhost:8080"}}`), true); err != nil {
		t.Errorf("dev http: %v", err)
	}
}

func TestVoiceTrusted(t *testing.T) {
	ok := &VoiceInfo{Addr: "voice.boson.chat:7700", URL: "https://voice.boson.chat", AuthURL: "https://auth.boson.chat"}
	if !voiceTrusted(ok, "https://auth.boson.chat/", false) {
		t.Error("boson.chat voice should be trusted")
	}
	if voiceTrusted(ok, "https://auth.example.org", false) {
		t.Error("another auth service must not be trusted")
	}
	// Someone else's server pointing at our auth service, to collect tokens.
	evil := &VoiceInfo{Addr: "voice.evil.org:7700", URL: "https://voice.evil.org", AuthURL: "https://auth.boson.chat"}
	if voiceTrusted(evil, "https://auth.boson.chat", false) {
		t.Error("a voice server outside the auth domain must not be trusted")
	}
	lookalike := &VoiceInfo{Addr: "voice.notboson.chat:7700", URL: "https://voice.boson.chat", AuthURL: "https://auth.boson.chat"}
	if voiceTrusted(lookalike, "https://auth.boson.chat", false) {
		t.Error("suffix match must be on a label boundary")
	}
	local := &VoiceInfo{Addr: "127.0.0.1:7700", URL: "http://127.0.0.1:7701", AuthURL: "http://localhost:8080"}
	if !voiceTrusted(local, "http://localhost:8080", true) {
		t.Error("dev builds trust a loopback voice server")
	}
	if voiceTrusted(local, "http://localhost:8080", false) {
		t.Error("release builds don't")
	}
	if voiceTrusted(nil, "https://auth.boson.chat", false) {
		t.Error("nil")
	}
}

// testDiscoverer serves boson.json from srv for every domain.
func testDiscoverer(t *testing.T, srv *httptest.Server, probe func(string) error) *voiceDiscoverer {
	t.Helper()
	d := newVoiceDiscoverer(t.TempDir(), false)
	d.http = srv.Client()
	d.wellKnownURL = func(domain string) string { return srv.URL + "/" + domain + "/.well-known/boson.json" }
	d.probe = func(_ context.Context, addr string) error { return probe(addr) }
	return d
}

func TestDiscoverWellKnownProbeAndCache(t *testing.T) {
	var mu sync.Mutex
	hits := map[string]int{}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		switch r.URL.Path {
		case "/boson.chat/.well-known/boson.json":
			_, _ = w.Write([]byte(bosonJSON))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	probed := []string{}
	d := testDiscoverer(t, srv, func(addr string) error {
		probed = append(probed, addr)
		if addr == "voice.probed.net:7700" {
			return nil
		}
		return errors.New("no")
	})
	ctx := context.Background()

	r := d.Discover(ctx, "irc.boson.chat", false)
	if r.Voice == nil || r.Voice.Source != "well-known" || r.Domain != "boson.chat" {
		t.Fatalf("boson: %+v", r)
	}
	// Cached: no second fetch.
	d.Discover(ctx, "irc.boson.chat", false)
	if hits["/boson.chat/.well-known/boson.json"] != 1 {
		t.Errorf("fetched %d times", hits["/boson.chat/.well-known/boson.json"])
	}
	// refresh re-checks.
	d.Discover(ctx, "irc.boson.chat", true)
	if hits["/boson.chat/.well-known/boson.json"] != 2 {
		t.Errorf("refresh didn't re-fetch")
	}

	// No boson.json, but a quicvoice server answers.
	r = d.Discover(ctx, "irc.probed.net", false)
	if r.Voice == nil || r.Voice.Source != "probe" || r.Voice.Addr != "voice.probed.net:7700" ||
		r.Voice.URL != "https://voice.probed.net" || r.Voice.AuthURL != "https://auth.probed.net" {
		t.Fatalf("probe: %+v", r.Voice)
	}

	// Neither: no voice (ircforever).
	r = d.Discover(ctx, "irc.ircforever.org", false)
	if r.Voice != nil || !r.Definitive {
		t.Fatalf("ircforever: %+v", r)
	}
	// IPs and single labels aren't looked up at all.
	n := len(probed)
	if r := d.Discover(ctx, "localhost", false); r.Voice != nil {
		t.Fatal("localhost has voice?")
	}
	if len(probed) != n {
		t.Error("localhost was probed")
	}

	// Expired: re-checked after a day.
	d.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	d.Discover(ctx, "irc.boson.chat", false)
	if hits["/boson.chat/.well-known/boson.json"] != 3 {
		t.Errorf("stale entry not re-checked")
	}

	// Persisted, and reloaded by a new discoverer.
	d2 := newVoiceDiscoverer(filepath.Dir(d.path), false)
	if c := d2.cached("irc.boson.chat"); c == nil || c.Voice == nil || c.Voice.Addr != "voice.boson.chat:7700" {
		t.Errorf("not persisted: %+v", c)
	}
}

func TestDiscoverNetworkFailureKeepsVoice(t *testing.T) {
	up := true
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(bosonJSON))
	}))
	defer srv.Close()
	d := testDiscoverer(t, srv, func(string) error { return errors.New("down") })
	d.wellKnownURL = func(domain string) string {
		if up {
			return srv.URL + "/.well-known/boson.json"
		}
		return "https://127.0.0.1:1/unreachable"
	}
	if r := d.Discover(context.Background(), "irc.boson.chat", false); r.Voice == nil {
		t.Fatal("no voice")
	}
	up = false
	if r := d.Discover(context.Background(), "irc.boson.chat", true); r.Voice == nil {
		t.Fatal("a network failure dropped voice")
	}
}

func TestDiscoverIgnoresTamperedCache(t *testing.T) {
	dir := t.TempDir()
	body := `{"irc.boson.chat":{"host":"irc.boson.chat","voice":{"addr":"nope","url":"https://v","authUrl":"https://a"},"checkedAt":"2026-01-01T00:00:00Z"}}`
	if err := os.WriteFile(filepath.Join(dir, "voice-servers.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if c := newVoiceDiscoverer(dir, false).cached("irc.boson.chat"); c != nil {
		t.Errorf("loaded an invalid entry: %+v", c)
	}
}

func TestFetchVoiceRooms(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/rooms" {
			http.NotFound(w, r)
			return
		}
		switch r.Header.Get("Authorization") {
		case "Bearer good":
			_, _ = w.Write([]byte(`{"rooms":[{"id":"general","name":"General","participants":[{"session_id":3,"user_id":"usr_1","name":"alice","muted":true,"deafened":false,"speaking":true}]},{"id":"afk","participants":[]},{"name":"no id"}]}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer srv.Close()
	r := fetchVoiceRooms(context.Background(), srv.Client(), srv.URL, "good")
	if r.Error != "" || len(r.Rooms) != 2 {
		t.Fatalf("rooms: %+v", r)
	}
	g := r.Rooms[0]
	if g.ID != "general" || g.Name != "General" || len(g.Participants) != 1 {
		t.Fatalf("general: %+v", g)
	}
	if p := g.Participants[0]; p.SessionID != 3 || p.UserID != "usr_1" || p.Name != "alice" || !p.Muted || !p.Speaking {
		t.Errorf("participant: %+v", p)
	}
	if r.Rooms[1].Name != "afk" {
		t.Errorf("unnamed room takes its id: %+v", r.Rooms[1])
	}
	if r := fetchVoiceRooms(context.Background(), srv.Client(), srv.URL, "bad"); r.ErrorKind != "token" {
		t.Errorf("401: %+v", r)
	}
	if r := fetchVoiceRooms(context.Background(), srv.Client(), srv.URL+"/missing", "good"); r.ErrorKind != "unavailable" {
		t.Errorf("404: %+v", r)
	}
	if r := fetchVoiceRooms(context.Background(), srv.Client(), "http://127.0.0.1:1", "good"); r.ErrorKind != "unreachable" {
		t.Errorf("down: %+v", r)
	}
}

// ---- the service, with a fake connection and audio ----

type fakeConn struct {
	mu       sync.Mutex
	room     string
	state    *controlpb.RoomState
	joinErr  error
	mutes    [][2]bool
	done     chan struct{}
	closed   bool
	onCtl    func(*controlpb.ControlMessage)
	closeErr error
}

func (c *fakeConn) Join(_ context.Context, room string) (*controlpb.RoomState, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.room = room
	if c.joinErr != nil {
		return nil, c.joinErr
	}
	return c.state, nil
}
func (c *fakeConn) SetMute(m, d bool) error {
	c.mu.Lock()
	c.mutes = append(c.mutes, [2]bool{m, d})
	c.mu.Unlock()
	return nil
}
func (c *fakeConn) SendAudio(*wire.Uplink) error { return nil }
func (c *fakeConn) Ping() error                  { return nil }
func (c *fakeConn) Stats() client.Stats          { return client.Stats{RTT: 40 * time.Millisecond} }
func (c *fakeConn) Done() <-chan struct{}        { return c.done }
func (c *fakeConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.done)
	}
	return c.closeErr
}

type fakeAudio struct {
	mu                             sync.Mutex
	startErr                       error
	starts, stops                  int
	running                        bool
	sender                         voiceSender
	muted, deafened, ptt, loopback bool
	threshold                      float32
	volumes                        map[uint16]float32
	removed                        []uint16
	speaking                       map[uint16]bool
}

func (a *fakeAudio) Start(string, string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.startErr != nil {
		return a.startErr
	}
	a.starts++
	a.running = true
	return nil
}
func (a *fakeAudio) Stop() {
	a.mu.Lock()
	a.stops++
	a.running = false
	a.mu.Unlock()
}
func (a *fakeAudio) Devices() ([]VoiceDevice, []VoiceDevice, error) {
	return []VoiceDevice{{ID: "", Name: "Default", IsDefault: true}}, nil, nil
}
func (a *fakeAudio) HandleAudio(wire.Downlink) {}
func (a *fakeAudio) RemoveSender(sid uint16) {
	a.mu.Lock()
	a.removed = append(a.removed, sid)
	a.mu.Unlock()
}
func (a *fakeAudio) SetSender(s voiceSender) { a.mu.Lock(); a.sender = s; a.mu.Unlock() }
func (a *fakeAudio) SetPushToTalk(on bool)   { a.mu.Lock(); a.ptt = on; a.mu.Unlock() }
func (a *fakeAudio) SetPTT(bool)             {}
func (a *fakeAudio) SetMuted(m bool)         { a.mu.Lock(); a.muted = m; a.mu.Unlock() }
func (a *fakeAudio) SetDeafened(d bool)      { a.mu.Lock(); a.deafened = d; a.mu.Unlock() }
func (a *fakeAudio) SetLoopback(on bool)     { a.mu.Lock(); a.loopback = on; a.mu.Unlock() }
func (a *fakeAudio) SetUserVolume(sid uint16, g float32) {
	a.mu.Lock()
	if a.volumes == nil {
		a.volumes = map[uint16]float32{}
	}
	a.volumes[sid] = g
	a.mu.Unlock()
}
func (a *fakeAudio) SetVADThreshold(u float32) { a.mu.Lock(); a.threshold = u; a.mu.Unlock() }
func (a *fakeAudio) Stats() audioStats {
	a.mu.Lock()
	defer a.mu.Unlock()
	return audioStats{MicLevel: 0.5, Transmitting: true, Speaking: a.speaking}
}
func (a *fakeAudio) Close() {}

type voiceHarness struct {
	svc   *VoiceService
	audio *fakeAudio
	conns []*fakeConn
	dials []client.Config
	mic   micAccess
}

func newVoiceHarness(t *testing.T) *voiceHarness {
	t.Helper()
	h := &voiceHarness{audio: &fakeAudio{speaking: map[uint16]bool{7: true}}, mic: micGranted}
	s := NewVoiceService(t.TempDir(), "https://auth.boson.chat", false)
	s.emit = func(string, any) {}
	s.newAudio = func() (audioBackend, error) { return h.audio, nil }
	s.micAuth = func(bool) micAccess { return h.mic }
	s.dial = func(_ context.Context, cfg client.Config) (voiceConn, error) {
		h.dials = append(h.dials, cfg)
		c := &fakeConn{done: make(chan struct{}), onCtl: cfg.OnControl, state: &controlpb.RoomState{
			Room: "general", YourSessionId: 5,
			Participants: []*controlpb.Participant{
				{SessionId: 5, UserId: "usr_me", DisplayName: "me"},
				{SessionId: 7, UserId: "usr_alice", DisplayName: "alice", SelfMuted: true},
			},
		}}
		h.conns = append(h.conns, c)
		return c, nil
	}
	s.disc.cache["irc.boson.chat"] = &VoiceDiscovery{Host: "irc.boson.chat", CheckedAt: time.Now(), Definitive: true,
		Voice: &VoiceInfo{Addr: "voice.boson.chat:7700", URL: "https://voice.boson.chat", AuthURL: "https://auth.boson.chat", Source: "well-known"}}
	s.disc.cache["irc.evil.org"] = &VoiceDiscovery{Host: "irc.evil.org", CheckedAt: time.Now(), Definitive: true,
		Voice: &VoiceInfo{Addr: "voice.evil.org:7700", URL: "https://voice.evil.org", AuthURL: "https://auth.boson.chat", Source: "well-known"}}
	h.svc = s
	t.Cleanup(func() { _ = s.ServiceShutdown() })
	return h
}

func TestVoiceJoinAndLeave(t *testing.T) {
	h := newVoiceHarness(t)
	h.svc.SetUserVolume("usr_alice", 150)
	st := h.svc.Join(VoiceJoinRequest{Host: "IRC.boson.chat", Room: "general", RoomName: "General", Token: "tok"})
	if st.Status != "connected" || st.Room != "general" || st.RoomName != "General" || st.Host != "irc.boson.chat" {
		t.Fatalf("state: %+v", st)
	}
	if h.dials[0].Addr != "voice.boson.chat:7700" || h.dials[0].Token != "tok" || h.dials[0].InsecureSkipVerify {
		t.Errorf("dial: %+v", h.dials[0])
	}
	if h.conns[0].room != "general" {
		t.Errorf("joined %q", h.conns[0].room)
	}
	if !h.audio.running || h.audio.sender == nil {
		t.Error("audio not wired up")
	}
	if h.audio.volumes[7] != 1.5 {
		t.Errorf("saved volume not applied: %v", h.audio.volumes)
	}
	if len(st.Participants) != 2 || !st.Participants[0].Self || st.Participants[1].Name != "alice" ||
		!st.Participants[1].Muted || !st.Participants[1].Speaking || st.Participants[1].Volume != 150 {
		t.Fatalf("participants: %+v", st.Participants)
	}
	if st.Quality != "good" || st.RTTMs != 40 {
		t.Errorf("quality %q rtt %v", st.Quality, st.RTTMs)
	}

	// Control events update the roster.
	h.conns[0].onCtl(&controlpb.ControlMessage{Msg: &controlpb.ControlMessage_ParticipantJoined{
		ParticipantJoined: &controlpb.ParticipantJoined{Participant: &controlpb.Participant{SessionId: 9, UserId: "usr_bob", DisplayName: "bob"}},
	}})
	h.conns[0].onCtl(&controlpb.ControlMessage{Msg: &controlpb.ControlMessage_ParticipantLeft{
		ParticipantLeft: &controlpb.ParticipantLeft{SessionId: 7},
	}})
	st = h.svc.State()
	if len(st.Participants) != 2 || st.Participants[1].Name != "bob" {
		t.Fatalf("after join/leave: %+v", st.Participants)
	}

	h.svc.Leave()
	st = h.svc.State()
	if st.Status != "idle" || st.Room != "" || len(st.Participants) != 0 {
		t.Fatalf("after leave: %+v", st)
	}
	if !h.conns[0].closed || h.audio.running || h.audio.sender != nil {
		t.Error("leave didn't hang up and close the mic")
	}
}

func TestVoiceOneConnectionAtATime(t *testing.T) {
	h := newVoiceHarness(t)
	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t1"})
	st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "music", Token: "t2"})
	if !h.conns[0].closed {
		t.Error("the first room wasn't left")
	}
	if st.Status != "connected" || h.conns[1].room != "music" {
		t.Errorf("second join: %+v", st)
	}
	// The first connection ending isn't an error now.
	time.Sleep(20 * time.Millisecond)
	if st := h.svc.State(); st.Status != "connected" {
		t.Errorf("old connection's end leaked: %+v", st)
	}
}

func TestVoiceMuteDeafen(t *testing.T) {
	h := newVoiceHarness(t)
	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t"})
	st := h.svc.SetDeafened(true)
	if !st.Deafened || !h.audio.muted || !h.audio.deafened {
		t.Errorf("deafen: %+v audio muted=%v deaf=%v", st, h.audio.muted, h.audio.deafened)
	}
	if got := h.conns[0].mutes[len(h.conns[0].mutes)-1]; got != [2]bool{true, true} {
		t.Errorf("server told %v", got)
	}
	// Unmuting undeafens.
	st = h.svc.SetMuted(false)
	if st.Muted || st.Deafened || h.audio.muted {
		t.Errorf("unmute: %+v", st)
	}
	st = h.svc.SetMuted(true)
	if !st.Participants[0].Muted {
		t.Error("own row doesn't show muted")
	}
}

func TestVoiceErrors(t *testing.T) {
	h := newVoiceHarness(t)
	// A server whose voice isn't under the auth domain.
	if st := h.svc.Join(VoiceJoinRequest{Host: "irc.evil.org", Room: "general", Token: "t"}); st.ErrorKind != "unavailable" || len(h.dials) != 0 {
		t.Errorf("evil: %+v", st)
	}
	if st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general"}); st.ErrorKind != "token" {
		t.Errorf("no token: %+v", st)
	}

	h.mic = micDenied
	st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t"})
	if st.Status != "error" || st.ErrorKind != "mic" || len(h.dials) != 0 {
		t.Errorf("mic denied: %+v", st)
	}
	h.mic = micGranted

	h.audio.startErr = errors.New("no such device")
	if st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t"}); st.ErrorKind != "device" {
		t.Errorf("device: %+v", st)
	}
	h.audio.startErr = nil

	h.svc.dial = func(context.Context, client.Config) (voiceConn, error) {
		return nil, errors.New("dial voice.boson.chat:7700: timeout: no recent network activity")
	}
	if st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t"}); st.ErrorKind != "unreachable" {
		t.Errorf("unreachable: %+v", st)
	}
	if h.audio.running {
		t.Error("mic left open after a failed join")
	}
	h.svc.dial = func(context.Context, client.Config) (voiceConn, error) {
		return nil, errors.New("server: TOKEN_EXPIRED: expired")
	}
	if st := h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t"}); st.ErrorKind != "token" {
		t.Errorf("token: %+v", st)
	}
	h.svc.DismissError()
	if st := h.svc.State(); st.Status != "idle" || st.Error != "" {
		t.Errorf("dismiss: %+v", st)
	}
}

func TestVoiceDropped(t *testing.T) {
	h := newVoiceHarness(t)
	h.svc.Join(VoiceJoinRequest{Host: "irc.boson.chat", Room: "general", Token: "t"})
	_ = h.conns[0].Close() // the server went away
	deadline := time.Now().Add(time.Second)
	for h.svc.State().Status != "error" && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	st := h.svc.State()
	if st.ErrorKind != "dropped" || !strings.Contains(st.Error, "Lost") {
		t.Errorf("dropped: %+v", st)
	}
}

func TestVoiceMicTest(t *testing.T) {
	h := newVoiceHarness(t)
	st := h.svc.MicTest(true)
	if !st.MicTest || !h.audio.loopback || !h.audio.running || st.MicLevel != 0.5 {
		t.Errorf("mic test on: %+v", st)
	}
	st = h.svc.MicTest(false)
	if st.MicTest || h.audio.loopback || h.audio.running {
		t.Errorf("mic test off: %+v", st)
	}
	h.mic = micDenied
	if st := h.svc.MicTest(true); st.MicTest || st.MicTestError == "" || st.Status != "idle" {
		t.Errorf("mic test denied: %+v", st)
	}
}

func TestVoiceSettings(t *testing.T) {
	h := newVoiceHarness(t)
	h.svc.Devices() // opens the backend
	h.svc.SetVADThreshold(-30)
	if h.audio.threshold != 0.5 {
		t.Errorf("threshold %v", h.audio.threshold)
	}
	h.svc.SetInputMode("ptt")
	if !h.audio.ptt || !h.svc.State().PushToTalk {
		t.Error("ptt")
	}
	if d := h.svc.Devices(); len(d.Inputs) != 1 || d.Error != "" {
		t.Errorf("devices: %+v", d)
	}
}

func TestVoiceDiscoverReportsTrust(t *testing.T) {
	h := newVoiceHarness(t)
	if r := h.svc.Discover("irc.boson.chat", false); !r.Available || r.AuthURL != "https://auth.boson.chat" {
		t.Errorf("boson: %+v", r)
	}
	if r := h.svc.Discover("irc.evil.org", false); r.Available {
		t.Errorf("evil: %+v", r)
	}
	if r := h.svc.Rooms("irc.evil.org", "t"); r.ErrorKind != "unavailable" {
		t.Errorf("evil rooms: %+v", r)
	}
}

func TestClassifyVoiceError(t *testing.T) {
	cases := map[string]string{
		"server: UNAUTHENTICATED: bad token":             "token",
		"join \"x\": ROOM_FULL: full":                    "server",
		"join \"x\": ROOM_NOT_FOUND: nope":               "server",
		"join \"x\": FORBIDDEN: no":                      "server",
		"dial voice.boson.chat:7700: no recent activity": "unreachable",
	}
	for msg, want := range cases {
		if kind, _ := classifyVoiceError(errors.New(msg), strings.HasPrefix(msg, "dial")); kind != want {
			t.Errorf("%q → %q, want %q", msg, kind, want)
		}
	}
}
