package main

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	qvclient "github.com/boson-chat/quicvideo/client"
	videopb "github.com/boson-chat/quicvideo/gen/controlpb"
	voicepb "github.com/boson-chat/quicvoice/gen/controlpb"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// ---- fakes ----

// ticketConn is a voice connection that hands out video tickets.
type ticketConn struct {
	*fakeConn
	mu      sync.Mutex
	err     error
	perms   string
	tickets int
}

func ticketToken(perms string) string {
	payload := `{"sub":"usr_me","rooms":["general"],"perms":[` + perms + `]}`
	return "e30." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
}

func (c *ticketConn) VideoTicket(context.Context) (*voicepb.VideoTicket, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tickets++
	if c.err != nil {
		return nil, c.err
	}
	return &voicepb.VideoTicket{Token: ticketToken(c.perms), QuicUrl: "quic://video.boson.chat:7710", Room: "general",
		ExpiresAt: time.Now().Add(5 * time.Minute).Unix()}, nil
}

type fakeVideoConn struct {
	mu     sync.Mutex
	room   string
	state  *videopb.RoomState
	subs   map[uint32]uint32
	unsubs []uint32
	stalls []uint32
	events chan *videopb.ControlMessage
	done   chan struct{}
	closed bool
}

func (c *fakeVideoConn) Join(_ context.Context, room string) (*videopb.RoomState, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.room = room
	return c.state, nil
}
func (c *fakeVideoConn) Subscribe(id, layer, _ uint32) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.subs[id] = layer
	return nil
}
func (c *fakeVideoConn) Unsubscribe(id uint32) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.subs, id)
	c.unsubs = append(c.unsubs, id)
	return nil
}
func (c *fakeVideoConn) ReportDecodeStall(id uint32) {
	c.mu.Lock()
	c.stalls = append(c.stalls, id)
	c.mu.Unlock()
}
func (c *fakeVideoConn) Events() <-chan *videopb.ControlMessage { return c.events }
func (c *fakeVideoConn) Done() <-chan struct{}                  { return c.done }
func (c *fakeVideoConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.done)
	}
	return nil
}
func (c *fakeVideoConn) isClosed() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.closed }

type fakeShare struct {
	name  string
	stops atomic.Int32
}

func (s *fakeShare) Stop()        { s.stops.Add(1) }
func (s *fakeShare) Name() string { return s.name }

// fakeMedia starts shares after delay (or fails); onEnd is kept so a test
// can end a share as if the device went away.
type fakeMedia struct {
	mu     sync.Mutex
	delay  time.Duration
	err    error
	shares []*fakeShare
	onEnd  func(error)
}

func (m *fakeMedia) Cameras() ([]VideoCamera, error) {
	return []VideoCamera{{ID: "cam1", Name: "FaceTime HD Camera", Kind: "builtin", Default: true}}, nil
}
func (m *fakeMedia) Screens() ([]VideoSource, error) {
	return []VideoSource{{ID: "display:1", Name: "Screen 1 (main)", Kind: "display"}}, nil
}
func (m *fakeMedia) start(ctx context.Context, name string, onEnd func(error)) (videoShare, error) {
	select {
	case <-time.After(m.delay):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return nil, m.err
	}
	s := &fakeShare{name: name}
	m.shares = append(m.shares, s)
	m.onEnd = onEnd
	return s, nil
}
func (m *fakeMedia) StartCamera(ctx context.Context, _ *qvclient.Client, _ string, _ func(int, int, []byte), onEnd func(error)) (videoShare, error) {
	return m.start(ctx, "FaceTime HD Camera", onEnd)
}
func (m *fakeMedia) StartScreen(ctx context.Context, _ *qvclient.Client, _ string, onEnd func(error)) (videoShare, error) {
	return m.start(ctx, "screen", onEnd)
}
func (m *fakeMedia) share(i int) *fakeShare {
	m.mu.Lock()
	defer m.mu.Unlock()
	if i >= len(m.shares) {
		return nil
	}
	return m.shares[i]
}

type videoHarness struct {
	svc   *VideoService
	media *fakeMedia
	conns []*fakeVideoConn
	opts  []qvclient.Options
	addrs []string
	mu    sync.Mutex
}

func newVideoHarness(t *testing.T) *videoHarness {
	t.Helper()
	h := &videoHarness{media: &fakeMedia{}}
	v := NewVideoService()
	v.media = h.media
	v.emit = func(string, any) {}
	v.dial = func(_ context.Context, addr string, opts qvclient.Options) (videoConn, error) {
		c := &fakeVideoConn{subs: map[uint32]uint32{}, events: make(chan *videopb.ControlMessage, 16), done: make(chan struct{}),
			state: &videopb.RoomState{Room: "general", YourSessionId: 1,
				Participants: []*videopb.Participant{
					{SessionId: 1, UserId: "usr_me", DisplayName: "me"},
					{SessionId: 2, UserId: "usr_alice", DisplayName: "alice"},
				},
				Tracks: []*videopb.Track{{TrackId: 10, SessionId: 2, Kind: videopb.TrackKind_CAMERA,
					Layers: []*videopb.Layer{{Id: 0, Width: 320, Height: 180, Fps: 15}, {Id: 1, Width: 640, Height: 360, Fps: 30}}}},
			}}
		h.mu.Lock()
		h.conns = append(h.conns, c)
		h.opts = append(h.opts, opts)
		h.addrs = append(h.addrs, addr)
		h.mu.Unlock()
		return c, nil
	}
	h.svc = v
	_ = v.ServiceStartup(context.Background(), application.ServiceOptions{})
	t.Cleanup(func() { _ = v.ServiceShutdown() })
	return h
}

func (h *videoHarness) conn(i int) *fakeVideoConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if i >= len(h.conns) {
		return nil
	}
	return h.conns[i]
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (h *videoHarness) join(t *testing.T, perms string) *ticketConn {
	t.Helper()
	tc := &ticketConn{fakeConn: &fakeConn{done: make(chan struct{})}, perms: perms}
	h.svc.voiceJoined(tc)
	waitUntil(t, "video connected", func() bool { return h.svc.State().Status == "connected" })
	return tc
}

// ---- tests ----

func TestVideoJoinsWithTicket(t *testing.T) {
	h := newVideoHarness(t)
	h.join(t, `"video.publish"`)
	st := h.svc.State()
	if !st.Available || !st.CanPublish || !st.CanCapture || st.FrameURL == "" {
		t.Fatalf("state %+v", st)
	}
	if h.addrs[0] != "video.boson.chat:7710" || h.opts[0].TLS.ServerName != "video.boson.chat" || h.opts[0].Token == "" ||
		h.opts[0].TLS.InsecureSkipVerify {
		t.Fatalf("dial %s %+v", h.addrs[0], h.opts[0])
	}
	if h.conn(0).room != "general" {
		t.Fatalf("joined %q", h.conn(0).room)
	}
	if len(st.Tracks) != 1 || st.Tracks[0].Name != "alice" || st.Tracks[0].UserID != "usr_alice" || st.Tracks[0].Self ||
		st.Tracks[0].Kind != "camera" || len(st.Tracks[0].Layers) != 2 {
		t.Fatalf("tracks %+v", st.Tracks)
	}
}

// Servers without video (no ticket) and voice connections that can't ask
// keep the feature hidden.
func TestVideoHiddenWithoutTicket(t *testing.T) {
	h := newVideoHarness(t)
	tc := &ticketConn{fakeConn: &fakeConn{done: make(chan struct{})}, err: errors.New("FORBIDDEN: video isn't enabled on this network")}
	h.svc.voiceJoined(tc)
	h.svc.voiceJoined(&fakeConn{done: make(chan struct{})})
	time.Sleep(100 * time.Millisecond)
	if st := h.svc.State(); st.Available || st.Status != "idle" || st.FrameURL != "" || h.conn(0) != nil {
		t.Fatalf("video showed without a ticket: %+v", st)
	}
}

func TestVideoTicketRefreshUsesVoice(t *testing.T) {
	h := newVideoHarness(t)
	tc := h.join(t, "")
	if h.svc.State().CanPublish {
		t.Fatal("a listener's ticket allows publishing")
	}
	tok, err := h.opts[0].TokenSource(context.Background())
	if err != nil || tok == "" {
		t.Fatalf("refresh: %q %v", tok, err)
	}
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if tc.tickets != 2 {
		t.Fatalf("%d tickets asked for", tc.tickets)
	}
}

func TestVideoTracksAndSubscriptions(t *testing.T) {
	h := newVideoHarness(t)
	h.join(t, `"video.publish"`)
	c := h.conn(0)
	c.events <- &videopb.ControlMessage{Msg: &videopb.ControlMessage_ParticipantJoined{ParticipantJoined: &videopb.ParticipantJoined{
		Participant: &videopb.Participant{SessionId: 3, UserId: "usr_bob", DisplayName: "bob"}}}}
	c.events <- &videopb.ControlMessage{Msg: &videopb.ControlMessage_TrackAdded{TrackAdded: &videopb.TrackAdded{
		Track: &videopb.Track{TrackId: 11, SessionId: 3, Kind: videopb.TrackKind_SCREEN}}}}
	c.events <- &videopb.ControlMessage{Msg: &videopb.ControlMessage_TrackAdded{TrackAdded: &videopb.TrackAdded{
		Track: &videopb.Track{TrackId: 12, SessionId: 1, Kind: videopb.TrackKind_CAMERA}}}}
	waitUntil(t, "tracks added", func() bool { return len(h.svc.State().Tracks) == 3 })
	st := h.svc.State()
	if st.Tracks[1].Name != "bob" || st.Tracks[1].Kind != "screen" || !st.Tracks[2].Self {
		t.Fatalf("tracks %+v", st.Tracks)
	}

	h.svc.Subscribe(10, 1)
	h.svc.Subscribe(10, 1) // same: not sent again
	h.svc.Subscribe(99, 0) // unknown track: ignored
	c.mu.Lock()
	if c.subs[10] != 1 || len(c.subs) != 1 {
		t.Fatalf("subs %v", c.subs)
	}
	c.mu.Unlock()
	h.svc.Unsubscribe(10)
	h.svc.Unsubscribe(10)
	c.mu.Lock()
	if len(c.unsubs) != 1 {
		t.Fatalf("unsubs %v", c.unsubs)
	}
	c.mu.Unlock()

	c.events <- &videopb.ControlMessage{Msg: &videopb.ControlMessage_TrackRemoved{TrackRemoved: &videopb.TrackRemoved{TrackId: 11}}}
	waitUntil(t, "track removed", func() bool { return len(h.svc.State().Tracks) == 2 })

	h.svc.keyframeNeeded(10)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.stalls) != 1 || c.stalls[0] != 10 {
		t.Fatalf("stalls %v", c.stalls)
	}
}

// Every way the call ends stops sharing and leaves the video room.
func TestVideoEnds(t *testing.T) {
	for name, end := range map[string]func(h *videoHarness){
		"voice left": func(h *videoHarness) { h.svc.voiceLeft() },
		"kicked": func(h *videoHarness) {
			h.conn(0).events <- &videopb.ControlMessage{Msg: &videopb.ControlMessage_Error{Error: &videopb.Error{
				Code: videopb.Error_KICKED, Message: "left the voice channel"}}}
		},
		"dropped": func(h *videoHarness) { _ = h.conn(0).Close() },
	} {
		t.Run(name, func(t *testing.T) {
			h := newVideoHarness(t)
			h.join(t, `"video.publish"`)
			h.svc.SetCamera(true, "")
			waitUntil(t, "camera on", func() bool { return h.svc.State().Camera.On })
			end(h)
			waitUntil(t, "camera released", func() bool { s := h.media.share(0); return s != nil && s.stops.Load() == 1 })
			waitUntil(t, "video left", func() bool { return h.conn(0).isClosed() && !h.svc.State().Camera.On })
			if st := h.svc.State(); st.Status == "connected" {
				t.Fatalf("still connected: %+v", st)
			}
		})
	}
}

func TestVideoShareLifecycle(t *testing.T) {
	h := newVideoHarness(t)
	h.join(t, `"video.publish"`)

	h.media.delay = 200 * time.Millisecond
	st := h.svc.SetCamera(true, "")
	if !st.Camera.Starting || st.Camera.On {
		t.Fatalf("starting: %+v", st.Camera)
	}
	// Off while starting: the start is abandoned, nothing stays on.
	h.svc.SetCamera(false, "")
	time.Sleep(400 * time.Millisecond)
	if st := h.svc.State(); st.Camera.On || st.Camera.Starting {
		t.Fatalf("camera after cancelling the start: %+v", st.Camera)
	}
	if s := h.media.share(0); s != nil && s.stops.Load() != 1 {
		t.Fatal("a share that started late wasn't released")
	}

	h.media.delay = 0
	h.svc.SetScreen(true, "display:1")
	waitUntil(t, "screen on", func() bool { return h.svc.State().Screen.On })
	if h.svc.State().Screen.Name != "screen" {
		t.Fatalf("screen %+v", h.svc.State().Screen)
	}
	// The source ends on its own (e.g. stopped from the system UI).
	h.media.mu.Lock()
	onEnd := h.media.onEnd
	h.media.mu.Unlock()
	onEnd(errors.New("the share was stopped"))
	waitUntil(t, "screen off after its end", func() bool { return !h.svc.State().Screen.On })
	if e := h.svc.State().Screen.Error; e != "Screen sharing stopped: the share was stopped" {
		t.Fatalf("error %q", e)
	}

	// A failing camera says why.
	h.media.err = errors.New("the built-in camera is off while the lid is closed")
	h.svc.SetCamera(true, "")
	waitUntil(t, "camera error", func() bool { return h.svc.State().Camera.Error != "" })
	if st := h.svc.State(); st.Camera.On || st.Camera.Starting {
		t.Fatalf("camera %+v", st.Camera)
	}
}

func TestVideoShareRefused(t *testing.T) {
	h := newVideoHarness(t)
	if st := h.svc.SetCamera(true, ""); st.Camera.Error != "Not in a call." {
		t.Fatalf("outside a call: %+v", st.Camera)
	}
	h.join(t, "")
	if st := h.svc.SetCamera(true, ""); st.Camera.Error != "You can't send video in this channel." {
		t.Fatalf("listener: %+v", st.Camera)
	}
	h.svc.media = nil
	if st := h.svc.SetScreen(true, ""); st.Screen.Error != "This version of the app can't send video." || st.CanCapture {
		t.Fatalf("no capture: %+v", st)
	}
	if len(h.svc.Cameras()) != 0 || len(h.svc.ScreenSources()) != 0 {
		t.Fatal("devices listed without capture")
	}
}

func TestVideoDevices(t *testing.T) {
	h := newVideoHarness(t)
	if c := h.svc.Cameras(); len(c) != 1 || !c[0].Default {
		t.Fatalf("cameras %+v", c)
	}
	if s := h.svc.ScreenSources(); len(s) != 1 || s[0].ID != "display:1" {
		t.Fatalf("screens %+v", s)
	}
}

// Lip-sync offsets go to the page per track, mapped through the track's
// owner to their voice user.
func TestVideoSyncOffsets(t *testing.T) {
	h := newVideoHarness(t)
	h.svc.offsets = func() map[string]int64 { return map[string]int64{"usr_alice": 87_000, "usr_nobody": 1} }
	h.join(t, `"video.publish"`)
	ws := dialHub(t, h.svc.hub.Load())
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		typ, b := readMsg(t, ws)
		if typ != 1 { // text
			continue
		}
		if string(b) == `{"type":"sync","offsets":{"10":87000}}` {
			return
		}
		t.Fatalf("sync %s", b)
	}
	t.Fatal("no sync message")
}

func TestQuicAddr(t *testing.T) {
	for in, want := range map[string][2]string{
		"quic://video.boson.chat:7710": {"video.boson.chat:7710", "video.boson.chat"},
		"quic://video.example.com":     {"video.example.com:7710", "video.example.com"},
		"quic://[::1]:9000":            {"[::1]:9000", "::1"},
	} {
		addr, sn, err := quicAddr(in)
		if err != nil || addr != want[0] || sn != want[1] {
			t.Errorf("%s → %s %s %v", in, addr, sn, err)
		}
	}
	if _, _, err := quicAddr("not a url"); err == nil {
		t.Error("bad url accepted")
	}
	if ticketCanPublish("garbage") || !ticketCanPublish(ticketToken(`"video.publish"`)) {
		t.Error("ticketCanPublish")
	}
}

// Lip sync: video arriving later than its sound plays delays that
// person's audio (once a second, on the worst lateness); video well early
// eases it off; their video gone for 2 s removes it; at most 150 ms.
func TestVideoAdaptiveAudioDelay(t *testing.T) {
	h := newVideoHarness(t)
	var mu sync.Mutex
	set := map[string]time.Duration{}
	h.svc.audioDelay = func(u string, d time.Duration) { mu.Lock(); set[u] = d; mu.Unlock() }
	now := time.Unix(1_800_000_000, 0)
	h.svc.now = func() time.Time { return now }
	h.join(t, `"video.publish"`)
	// alice's audio plays 80 ms after her capture time.
	h.svc.mu.Lock()
	h.svc.userOffsets = map[string]int64{"usr_alice": 80_000}
	h.svc.mu.Unlock()
	frame := func(lateBy time.Duration) {
		// arrives at now; captured so that now - (C + 80ms) = lateBy - decode budget
		c := now.UnixMicro() - 80_000 - (lateBy - videoDecodeBudget).Microseconds()
		h.svc.noteLateness(10, uint64(c))
	}
	step := func() { now = now.Add(adaptEvery); h.svc.adaptDelays() }
	get := func() time.Duration { mu.Lock(); defer mu.Unlock(); return set["usr_alice"] }

	// The 90th percentile counts, not one stray frame.
	for range 9 {
		frame(40 * time.Millisecond)
	}
	frame(400 * time.Millisecond)
	step()
	if d := get(); d != 50*time.Millisecond {
		t.Fatalf("after 40 ms late: %v, want 50ms", d)
	}
	// While the change settles (it applies from the next talk spurt),
	// frames are ignored.
	frame(300 * time.Millisecond)
	step()
	if d := get(); d != 50*time.Millisecond {
		t.Fatalf("decided while settling: %v", d)
	}
	frame(0) // settled now (2 s after the change); on time: no change
	step()
	// Early enough with the new delay: eases off.
	frame(-90 * time.Millisecond)
	step()
	if d := get(); d != 30*time.Millisecond {
		t.Fatalf("after 90 ms early: %v, want 30ms", d)
	}
	// Very late (once settled): capped.
	frame(0)
	step()
	frame(0)
	step()
	frame(500 * time.Millisecond)
	step()
	if d := get(); d != adaptMax {
		t.Fatalf("cap: %v", d)
	}
	// Video gone (tile hidden): the delay goes.
	now = now.Add(adaptIdle + time.Second)
	h.svc.adaptDelays()
	if d, ok := set["usr_alice"]; !ok || d != 0 {
		t.Fatalf("after idle: %v", d)
	}
	if len(h.svc.audioDelays()) != 0 {
		t.Fatal("state kept for an idle person")
	}
	// Frames from someone without an offset (no audio yet) don't count.
	h.svc.mu.Lock()
	h.svc.userOffsets = map[string]int64{}
	h.svc.mu.Unlock()
	frame(100 * time.Millisecond)
	step()
	if len(h.svc.audioDelays()) != 0 {
		t.Fatal("adapted without an offset")
	}
}
