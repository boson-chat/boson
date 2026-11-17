package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"net"
	"net/url"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	qvclient "github.com/boson-chat/quicvideo/client"
	videopb "github.com/boson-chat/quicvideo/gen/controlpb"
	voicepb "github.com/boson-chat/quicvoice/gen/controlpb"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// VideoService is video in voice channels: every voice channel is also a
// video channel. On joining a channel the app asks the voice server for a
// video ticket; servers without video (or older ones) say no, and the
// whole feature stays hidden (VideoState.Available). With a ticket it
// connects to the server's quicvideod, joins the channel's video room,
// and:
//
//   - receives the tracks the call view asks for (Subscribe, sized to each
//     tile) and hands them to the webview over a loopback WebSocket
//     (frameHub) as AVC for WebCodecs;
//   - publishes the camera and screen (native capture + hardware encode,
//     where this build has it: videoMedia);
//   - sends each sender's lip-sync offset (VoiceService.avOffsets) so the
//     page shows a video frame when the audio captured with it plays.
//
// Leaving voice leaves video; the voice server also removes us from the
// video room on its own when we leave the channel.
type VideoService struct {
	media videoMedia
	dial  func(ctx context.Context, addr string, opts qvclient.Options) (videoConn, error)
	emit  func(name string, data any)
	// offsets: lip-sync offsets per user id (VoiceService.avOffsets).
	offsets func() map[string]int64
	// dev: a dev build, which accepts a local quicvideod's self-signed
	// certificate (loopback only), like voice.
	dev bool
	// audioDelay delays one person's audio (VoiceService.setAudioDelay):
	// when their video arrives later than their audio would play.
	audioDelay func(userID string, d time.Duration)
	// now is the clock (tests).
	now func() time.Time
	// sounds plays screen shares' sound (VoiceService: the voice engine's
	// mixer, voice_share_sound.go); nil = this build can't, and the video
	// server isn't asked for it.
	sounds shareSoundPlayer

	hubOnce sync.Once
	hub     atomic.Pointer[frameHub] // set once, on first use
	hubErr  error

	mu    sync.Mutex
	seq   int // bumped by every voice join/leave; a superseded start gives up
	sess  *videoSession
	st    videoStatus
	dirty bool
	// Lip sync: the offsets last sent to the page, per user, and how late
	// each person's video arrives against them (adaptive audio delay).
	userOffsets map[string]int64
	adapt       map[string]*avAdapt

	stop    chan struct{}
	once    sync.Once
	pv      previewState // the pre-join camera preview (guarded by mu)
	thumbMu sync.Mutex
	thumbs  *thumbSession // the picker's thumbnails, while it's open
	// shareVol: how loud each screen share's sound is for us, percent
	// (0 = muted, 100 = as sent, up to 200), by screen track. Guarded by mu.
	shareVol map[uint32]int
	// soundOffs: the lip-sync offsets of shares whose sound is playing, by
	// screen track (sendSync), for the adaptive delay of their sound.
	soundOffs atomic.Pointer[map[uint32]int64]
}

// shareSoundPlayer plays screen shares' sound (*VoiceService).
type shareSoundPlayer interface {
	playShareSound(track uint32, captureUS uint64, payload []byte, gain float32)
	removeShareSound(track uint32)
	setShareSoundGain(track uint32, gain float32)
	shareSoundOffset(track uint32) (int64, bool)
	setShareSoundDelay(track uint32, d time.Duration)
}

// videoStatus is what State reports besides the session's tracks.
type videoStatus struct {
	available  bool   // the current voice server offers video
	status     string // idle | connecting | connected | error
	err        string
	canPublish bool
	camera     shareStatus
	screen     shareStatus
	// camWant: the user turned the camera on and hasn't turned it off.
	// It outlives the capture (iOS and Android stop the camera in the
	// background, a Mac's sleeps), so ResumeCamera can restart it.
	// Cleared by "Camera off", leaving the call, and a restart that fails.
	camWant   bool
	camWantID string
	// screenMode: what the screen share is optimized for, "detail" or
	// "motion" (set before it starts; kept while it runs).
	screenMode string
	// screenSound: the share should carry its sound (the picker's "Share
	// sound"; set before it starts).
	screenSound bool
}

type shareStatus struct {
	on, starting bool
	paused       bool   // camera: stopped by the system, restarts on resume
	id           string // the camera or source asked for ("" = the default)
	facing       string // the running camera's facing (VideoShareState.Facing)
	name, err    string
	gen          int // bumped on every start/stop; a superseded start gives up
	share        videoShare
}

// videoConn is what VideoService needs of a quicvideo connection
// (*qvclient.Client), so tests can fake one.
type videoConn interface {
	Join(ctx context.Context, room string) (*videopb.RoomState, error)
	Subscribe(trackID, maxLayer, priority uint32) error
	Unsubscribe(trackID uint32) error
	ReportDecodeStall(trackID uint32)
	Events() <-chan *videopb.ControlMessage
	Done() <-chan struct{}
	Close() error
}

// videoTicketer is a voice connection that hands out video tickets
// (quicvoice 1.8+: *client.Client).
type videoTicketer interface {
	VideoTicket(ctx context.Context) (*voicepb.VideoTicket, error)
}

// videoSession is one connection to a video room.
type videoSession struct {
	conn   videoConn
	client *qvclient.Client // the real client (publishing), nil in tests
	room   string
	self   uint32 // our video session id
	people map[uint32]videoPerson
	tracks map[uint32]*videopb.Track
	subs   map[uint32]uint32 // track → max layer asked for
	// canSound: the server relays screen shares' sound (its Welcome lists
	// the screen-audio capability).
	canSound bool
}

// soundFor is the sound track of a screen share (0 if it has none).
// Called with v.mu held.
func (s *videoSession) soundFor(screen uint32) uint32 {
	for id, tr := range s.tracks {
		if tr.GetKind() == videopb.TrackKind_SCREEN_AUDIO && tr.GetForTrackId() == screen {
			return id
		}
	}
	return 0
}

type videoPerson struct{ userID, name string }

// VideoTrack is a track in the call.
type VideoTrack struct {
	TrackID int          `json:"trackId"`
	UserID  string       `json:"userId"`
	Name    string       `json:"name"`
	Kind    string       `json:"kind"` // camera | screen
	Self    bool         `json:"self"`
	Layers  []VideoLayer `json:"layers"`
	// Sound: a screen share that carries its sound; Volume is how loud it
	// is for us, percent (0 = muted, 100 = as sent, up to 200).
	Sound  bool `json:"sound,omitempty"`
	Volume int  `json:"volume"`
}

type VideoLayer struct {
	ID     int `json:"id"`
	Width  int `json:"width"`
	Height int `json:"height"`
	FPS    int `json:"fps"`
}

// VideoShareState is the camera or the screen share.
type VideoShareState struct {
	On       bool `json:"on"`
	Starting bool `json:"starting"`
	// Paused: the camera was stopped by the system (the app went to the
	// background, the Mac slept) and turns back on when the app is active.
	Paused bool   `json:"paused,omitempty"`
	ID     string `json:"id,omitempty"`
	// Facing: the camera in use faces "front" (the user), "back", or ""
	// (a webcam). The UI mirrors its own preview unless it's "back"; what's
	// sent is never mirrored.
	Facing string `json:"facing,omitempty"`
	// Mode: a screen share is optimized for "detail" (text) or "motion".
	Mode string `json:"mode,omitempty"`
	// Sound: the screen share is sending its sound.
	Sound bool   `json:"sound,omitempty"`
	Name  string `json:"name,omitempty"`
	Error string `json:"error,omitempty"`
}

// VideoState is the whole video UI state.
type VideoState struct {
	// Available: the voice server offers video for this channel; the UI
	// shows nothing video until it does.
	Available bool `json:"available"`
	// Status: idle | connecting | connected | error.
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// FrameURL: the WebSocket the page reads frames from.
	FrameURL string `json:"frameUrl,omitempty"`
	// CanCapture: this build can send video (native capture); CanPublish:
	// the ticket allows it (people who can speak in the channel).
	CanCapture bool `json:"canCapture"`
	CanPublish bool `json:"canPublish"`
	// CanShareScreen: this build can share the screen too (not on iOS yet).
	CanShareScreen bool `json:"canShareScreen"`
	// CanPickScreen: the app's own picker lists screens and windows (with
	// thumbnails where the OS gives them); false where the system has its
	// own picker (Linux: the portal).
	CanPickScreen bool `json:"canPickScreen"`
	// CanShareAudio: "Share sound" with a screen share: this build and OS
	// can capture it (macOS 13+) and the video server relays it. The
	// picker hides the toggle otherwise.
	CanShareAudio bool            `json:"canShareAudio"`
	Camera        VideoShareState `json:"camera"`
	// Preview: the camera shown only to you, before joining (the pre-join
	// view's self-view); nothing is sent.
	Preview VideoShareState `json:"preview"`
	Screen  VideoShareState `json:"screen"`
	Tracks  []VideoTrack    `json:"tracks"`
}

const (
	VideoStateEvent  = "video:state"
	videoTicketWait  = 5 * time.Second
	videoDialTimeout = 8 * time.Second
	// syncEvery: how often lip-sync offsets go to the page.
	syncEvery = 200 * time.Millisecond
)

func init() {
	application.RegisterEvent[VideoState](VideoStateEvent)
}

func NewVideoService() *VideoService {
	return &VideoService{
		media: newVideoMedia(),
		dial: func(ctx context.Context, addr string, opts qvclient.Options) (videoConn, error) {
			return qvclient.Dial(ctx, addr, opts)
		},
		st:    videoStatus{status: "idle"},
		stop:  make(chan struct{}),
		now:   time.Now,
		adapt: map[string]*avAdapt{},
	}
}

// Adaptive audio delay (lip sync). A frame is due at capture + offset,
// the time its sound plays here; video that arrives later than that can't
// be on time, so that person's audio is delayed a little instead (ITU-R
// BT.1359: sound may lead the picture by at most 45 ms). Once a second
// per person, on the 90th percentile of the lateness seen (the worst frame
// is mostly scheduling noise): late → the delay grows by it + 10 ms; well
// early (> 50 ms) → it eases off 20 ms; at most 150 ms. A new delay only
// applies from the person's next talk spurt, so after a change the next
// decision waits 2 s (deciding on frames from before it overshoots).
// Their video gone for 2 s (tile hidden, call view closed) → no delay.
// Measured end to end: desktop/cmd/avmeasure.
const (
	videoDecodeBudget = 10 * time.Millisecond
	adaptEvery        = time.Second
	adaptMargin       = 10 * time.Millisecond
	adaptEase         = 20 * time.Millisecond
	adaptEarly        = 50 * time.Millisecond
	adaptMax          = 150 * time.Millisecond
	adaptIdle         = 2 * time.Second
	adaptSettle       = 2 * time.Second
)

type avAdapt struct {
	extra     time.Duration   // the delay now
	lates     []time.Duration // lateness of frames since the last decision
	lastFrame time.Time
	decided   time.Time
	changed   time.Time
}

func (v *VideoService) ServiceStartup(context.Context, application.ServiceOptions) error {
	v.watchResume(application.Get())
	go v.loop()
	return nil
}

func (v *VideoService) ServiceShutdown() error {
	v.once.Do(func() { close(v.stop) })
	v.voiceLeft()
	if h := v.hub.Load(); h != nil {
		h.Close()
	}
	return nil
}

// frames starts the loopback WebSocket on first use.
func (v *VideoService) frames() (*frameHub, error) {
	v.hubOnce.Do(func() {
		h, err := newFrameHub(v.keyframeNeeded)
		v.hubErr = err
		if err == nil {
			v.hub.Store(h)
		}
	})
	return v.hub.Load(), v.hubErr
}

func (v *VideoService) changed() {
	v.mu.Lock()
	v.dirty = true
	v.mu.Unlock()
}

// loop pushes the state when it changed and the lip-sync offsets while
// connected.
func (v *VideoService) loop() {
	t := time.NewTicker(syncEvery)
	defer t.Stop()
	for {
		select {
		case <-v.stop:
			return
		case <-t.C:
			v.mu.Lock()
			dirty, sess := v.dirty, v.sess
			v.dirty = false
			v.mu.Unlock()
			if dirty {
				v.send(VideoStateEvent, v.State())
			}
			if sess != nil {
				v.sendSync(sess)
			}
			v.adaptDelays()
		}
	}
}

func (v *VideoService) send(name string, data any) {
	if v.emit != nil {
		v.emit(name, data)
		return
	}
	if app := application.Get(); app != nil {
		app.Event.Emit(name, data)
	}
}

// ---- voice hooks ----

// voiceJoined: a voice join succeeded on conn (VoiceService.Join). Ask for
// a video ticket and, if the server has video, join the video room.
func (v *VideoService) voiceJoined(conn voiceConn) {
	v.stopPreview() // the pre-join preview ends at the door
	t, ok := conn.(videoTicketer)
	if !ok {
		return
	}
	v.mu.Lock()
	v.seq++
	seq := v.seq
	v.mu.Unlock()
	go v.start(seq, t)
}

// voiceLeft: we left voice (or were dropped or kicked): leave video too.
func (v *VideoService) voiceLeft() {
	v.stopPreview()
	v.mu.Lock()
	v.seq++
	sess := v.sess
	v.sess = nil
	cam, scr := v.st.camera.share, v.st.screen.share
	v.st = videoStatus{status: "idle"}
	v.dirty = true
	v.adapt = map[string]*avAdapt{} // the voice session (and its delays) is gone
	v.userOffsets = nil
	v.mu.Unlock()
	for _, s := range []videoShare{cam, scr} {
		if s != nil {
			s.Stop()
		}
	}
	if sess != nil {
		_ = sess.conn.Close()
	}
}

func (v *VideoService) current(seq int) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.seq == seq
}

func (v *VideoService) fail(seq int, msg string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.seq != seq {
		return
	}
	v.st.status, v.st.err = "error", msg
	v.dirty = true
}

func (v *VideoService) start(seq int, t videoTicketer) {
	ctx, cancel := context.WithTimeout(context.Background(), videoTicketWait)
	ticket, err := t.VideoTicket(ctx)
	cancel()
	if err != nil {
		// No video here: a server without it answers FORBIDDEN, an older
		// one doesn't answer at all. Either way the feature stays hidden.
		return
	}
	addr, serverName, err := quicAddr(ticket.GetQuicUrl())
	if err != nil {
		return
	}
	v.mu.Lock()
	if v.seq != seq {
		v.mu.Unlock()
		return
	}
	v.st.available, v.st.status, v.st.err = true, "connecting", ""
	v.st.canPublish = ticketCanPublish(ticket.GetToken())
	v.dirty = true
	v.mu.Unlock()

	if _, err := v.frames(); err != nil {
		v.fail(seq, "Video couldn't start: "+err.Error())
		return
	}
	dctx, dcancel := context.WithTimeout(context.Background(), videoDialTimeout)
	defer dcancel()
	var sess *videoSession
	conn, err := v.dial(dctx, addr, qvclient.Options{
		Token:         ticket.GetToken(),
		ClientVersion: "boson/" + appVersion,
		Capabilities:  v.capabilities(),
		TLS: &tls.Config{ServerName: serverName,
			// A local quicvideod (dev builds) has a self-signed certificate.
			InsecureSkipVerify: v.dev && isLoopbackHost(serverName)},
		OnFrame: func(f qvclient.RemoteFrame) {
			v.mu.Lock()
			current := v.sess == sess && sess != nil
			v.mu.Unlock()
			if current {
				v.onFrame(f)
			}
		},
		// Tickets last 5 minutes: get a new one from voice and refresh.
		TokenSource: func(ctx context.Context) (string, error) {
			nt, err := t.VideoTicket(ctx)
			if err != nil {
				return "", err
			}
			return nt.GetToken(), nil
		},
	})
	if err != nil {
		v.fail(seq, "Couldn't reach the video server.")
		return
	}
	state, err := conn.Join(dctx, ticket.GetRoom())
	if err != nil {
		_ = conn.Close()
		v.fail(seq, "The video server refused: "+err.Error())
		return
	}
	sess = &videoSession{conn: conn, room: ticket.GetRoom(), self: state.GetYourSessionId(),
		people: map[uint32]videoPerson{}, tracks: map[uint32]*videopb.Track{}, subs: map[uint32]uint32{}}
	if c, ok := conn.(*qvclient.Client); ok {
		sess.client = c
	}
	if c, ok := conn.(interface{ ServerCan(string) bool }); ok {
		sess.canSound = v.sounds != nil && c.ServerCan(qvclient.CapScreenAudio)
	}
	for _, p := range state.GetParticipants() {
		sess.people[p.GetSessionId()] = videoPerson{userID: p.GetUserId(), name: p.GetDisplayName()}
	}
	for _, tr := range state.GetTracks() {
		sess.tracks[tr.GetTrackId()] = tr
	}
	v.mu.Lock()
	if v.seq != seq {
		v.mu.Unlock()
		_ = conn.Close()
		return
	}
	v.sess = sess
	v.st.status = "connected"
	v.dirty = true
	v.mu.Unlock()
	go v.events(seq, sess)
}

// quicAddr turns a ticket's quic_url (quic://host:port) into a dial
// address and the TLS server name.
func quicAddr(raw string) (addr, serverName string, err error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", "", errors.New("video: bad server address")
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "7710"
	}
	return net.JoinHostPort(host, port), host, nil
}

// ticketCanPublish reads the ticket's perms claim (no verification: the
// video server checks; this only decides whether to show the buttons).
func ticketCanPublish(token string) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	payload, err := decodeSegment(parts[1])
	if err != nil {
		return false
	}
	return strings.Contains(string(payload), `"video.publish"`)
}

func decodeSegment(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

func (v *VideoService) events(seq int, sess *videoSession) {
	for {
		select {
		case <-sess.conn.Done():
			v.mu.Lock()
			current := v.sess == sess
			if current {
				v.sess = nil
				v.st.status, v.st.err = "error", "Lost the connection to the video server."
				v.dirty = true
			}
			v.mu.Unlock()
			if current {
				v.stopShares()
			}
			return
		case m, ok := <-sess.conn.Events():
			if !ok {
				continue
			}
			v.onControl(seq, sess, m)
		}
	}
}

func (v *VideoService) onControl(seq int, sess *videoSession, m *videopb.ControlMessage) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.sess != sess {
		return
	}
	switch {
	case m.GetParticipantJoined() != nil:
		p := m.GetParticipantJoined().GetParticipant()
		sess.people[p.GetSessionId()] = videoPerson{userID: p.GetUserId(), name: p.GetDisplayName()}
	case m.GetParticipantLeft() != nil:
		delete(sess.people, m.GetParticipantLeft().GetSessionId())
	case m.GetTrackAdded() != nil:
		tr := m.GetTrackAdded().GetTrack()
		sess.tracks[tr.GetTrackId()] = tr
		// A sound for a share we're watching: hear it too.
		if tr.GetKind() == videopb.TrackKind_SCREEN_AUDIO && tr.GetSessionId() != sess.self {
			if _, watching := sess.subs[tr.GetForTrackId()]; watching {
				sess.subs[tr.GetTrackId()] = 0
				go func(id uint32) { _ = sess.conn.Subscribe(id, 0, 0) }(tr.GetTrackId())
			}
		}
	case m.GetTrackRemoved() != nil:
		id := m.GetTrackRemoved().GetTrackId()
		if tr := sess.tracks[id]; tr != nil && tr.GetKind() == videopb.TrackKind_SCREEN_AUDIO && v.sounds != nil {
			go v.sounds.removeShareSound(id)
		}
		if tr := sess.tracks[id]; tr != nil && tr.GetKind() == videopb.TrackKind_SCREEN {
			delete(v.shareVol, id)
		}
		delete(sess.tracks, id)
		delete(sess.subs, id)
	case m.GetError() != nil && m.GetError().GetCode() == videopb.Error_KICKED:
		// Out of the video room (we left the voice channel, or it closed):
		// voice tells us separately; just tear video down.
		go func() {
			if v.current(seq) {
				v.voiceLeftVideoOnly(sess)
			}
		}()
	}
	v.dirty = true
}

// voiceLeftVideoOnly ends sess after a kick from the video server.
func (v *VideoService) voiceLeftVideoOnly(sess *videoSession) {
	v.mu.Lock()
	if v.sess != sess {
		v.mu.Unlock()
		return
	}
	v.sess = nil
	v.st.status = "idle"
	v.dirty = true
	v.mu.Unlock()
	v.stopShares()
	_ = sess.conn.Close()
}

func (v *VideoService) stopShares() {
	v.mu.Lock()
	cam, scr := v.st.camera.share, v.st.screen.share
	v.st.camera = shareStatus{gen: v.st.camera.gen + 1}
	v.st.screen = shareStatus{gen: v.st.screen.gen + 1}
	v.dirty = true
	v.mu.Unlock()
	for _, s := range []videoShare{cam, scr} {
		if s != nil {
			s.Stop()
		}
	}
}

// ---- receiving ----

func (v *VideoService) onFrame(f qvclient.RemoteFrame) {
	if _, gain, ok := v.soundTrack(f.TrackID); ok {
		v.sounds.playShareSound(f.TrackID, f.CaptureUS, f.Payload, gain)
		return
	}
	v.noteLateness(f.TrackID, f.CaptureUS)
	hub, _ := v.frames()
	if hub == nil {
		return
	}
	af, err := toAVC(f.Payload)
	if err != nil {
		return
	}
	if f.GroupStart && len(af.Desc) == 0 {
		af.Keyframe = true // a group starts on a keyframe even without inline SPS/PPS
	}
	hub.Frame(f.TrackID, f.Layer, f.CaptureUS, af)
}

func (v *VideoService) keyframeNeeded(trackID uint32) {
	v.mu.Lock()
	sess := v.sess
	v.mu.Unlock()
	if sess != nil {
		sess.conn.ReportDecodeStall(trackID)
	}
}

// Subscribe asks for a track up to layer (the largest that fits its
// tile); the call view calls it as tiles appear and resize.
func (v *VideoService) Subscribe(trackID, layer int) {
	v.mu.Lock()
	sess := v.sess
	if sess == nil || sess.tracks[uint32(trackID)] == nil {
		v.mu.Unlock()
		return
	}
	if cur, ok := sess.subs[uint32(trackID)]; ok && cur == uint32(layer) {
		v.mu.Unlock()
		return
	}
	sess.subs[uint32(trackID)] = uint32(layer)
	// Watching a share: hear it too.
	sound := uint32(0)
	if v.sounds != nil && sess.tracks[uint32(trackID)].GetKind() == videopb.TrackKind_SCREEN {
		if id := sess.soundFor(uint32(trackID)); id != 0 {
			if _, on := sess.subs[id]; !on {
				sess.subs[id] = 0
				sound = id
			}
		}
	}
	v.mu.Unlock()
	_ = sess.conn.Subscribe(uint32(trackID), uint32(layer), 0)
	if sound != 0 {
		_ = sess.conn.Subscribe(sound, 0, 0)
	}
}

// Unsubscribe stops receiving a track (its tile is hidden, or the call
// view is closed).
func (v *VideoService) Unsubscribe(trackID int) {
	v.mu.Lock()
	sess := v.sess
	if sess == nil {
		v.mu.Unlock()
		return
	}
	_, had := sess.subs[uint32(trackID)]
	delete(sess.subs, uint32(trackID))
	// Not watching a share any more: its sound stops with it.
	sound := sess.soundFor(uint32(trackID))
	_, soundOn := sess.subs[sound]
	if sound != 0 && soundOn {
		delete(sess.subs, sound)
	} else {
		sound = 0
	}
	v.mu.Unlock()
	if had {
		_ = sess.conn.Unsubscribe(uint32(trackID))
	}
	if sound != 0 {
		_ = sess.conn.Unsubscribe(sound)
		v.sounds.removeShareSound(sound)
	}
}

// soundTrack: trackID is a share's sound we play (its screen track, and
// the gain it's played at).
func (v *VideoService) soundTrack(trackID uint32) (screen uint32, gain float32, ok bool) {
	if v.sounds == nil {
		return 0, 0, false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.sess == nil {
		return 0, 0, false
	}
	tr := v.sess.tracks[trackID]
	if tr.GetKind() != videopb.TrackKind_SCREEN_AUDIO {
		return 0, 0, false
	}
	screen = tr.GetForTrackId()
	return screen, v.shareGainLocked(screen), true
}

func (v *VideoService) shareGainLocked(screen uint32) float32 {
	if p, ok := v.shareVol[screen]; ok {
		return float32(p) / 100
	}
	return 1
}

// SetShareVolume sets how loud a screen share's sound is for us, percent
// (0 = muted, 100 = as sent, up to 200). For this call only.
func (v *VideoService) SetShareVolume(trackID, percent int) VideoState {
	percent = min(max(percent, 0), 200)
	v.mu.Lock()
	sess := v.sess
	sound := uint32(0)
	if sess != nil && sess.tracks[uint32(trackID)].GetKind() == videopb.TrackKind_SCREEN {
		if v.shareVol == nil {
			v.shareVol = map[uint32]int{}
		}
		v.shareVol[uint32(trackID)] = percent
		sound = sess.soundFor(uint32(trackID))
		v.dirty = true
	}
	v.mu.Unlock()
	if sound != 0 && v.sounds != nil {
		v.sounds.setShareSoundGain(sound, float32(percent)/100)
	}
	return v.State()
}

func (v *VideoService) capabilities() []string {
	if v.sounds == nil {
		return nil
	}
	return []string{qvclient.CapScreenAudio}
}

// syncMsg is the lip-sync message on the frame socket: per track, the
// local wall clock offset (µs) to add to a frame's capture time to show it
// with its audio. Tracks of people whose audio isn't playing (or without
// sync reports) are missing: show those frames as they come.
type syncMsg struct {
	Type    string           `json:"type"` // "sync"
	Offsets map[uint32]int64 `json:"offsets"`
}

func (v *VideoService) sendSync(sess *videoSession) {
	hub := v.hub.Load()
	if v.offsets == nil || hub == nil {
		return
	}
	byUser := v.offsets()
	msg := syncMsg{Type: "sync", Offsets: map[uint32]int64{}}
	v.mu.Lock()
	v.userOffsets = byUser
	var sounds map[uint32]uint32 // screen → its sound, for shares with sound
	for id, tr := range sess.tracks {
		if tr.GetKind() == videopb.TrackKind_SCREEN_AUDIO {
			if sounds == nil {
				sounds = map[uint32]uint32{}
			}
			sounds[tr.GetForTrackId()] = id
			continue
		}
		if off, ok := byUser[sess.people[tr.GetSessionId()].userID]; ok {
			msg.Offsets[id] = off
		}
	}
	v.mu.Unlock()
	// A share with its sound playing is in sync with that sound, not with
	// its sharer's voice.
	offs := map[uint32]int64{}
	if v.sounds != nil {
		for screen, sound := range sounds {
			if off, ok := v.sounds.shareSoundOffset(sound); ok {
				msg.Offsets[screen] = off
				offs[screen] = off
			}
		}
	}
	v.soundOffs.Store(&offs)
	hub.Text(msg)
}

// noteLateness records how late a frame arrived against its due time
// (capture + its sender's offset), with time to decode it.
func (v *VideoService) noteLateness(trackID uint32, captureUS uint64) {
	now := v.now()
	v.mu.Lock()
	defer v.mu.Unlock()
	sess := v.sess
	if sess == nil {
		return
	}
	tr := sess.tracks[trackID]
	if tr == nil {
		return
	}
	// The adaptive delay's key: a person (their voice), or a share's sound.
	var user string
	var off int64
	var ok bool
	if tr.GetKind() == videopb.TrackKind_SCREEN {
		// A late screen frame mustn't delay its sharer's voice; it delays
		// the share's own sound, when it has one playing.
		sound := sess.soundFor(trackID)
		if sound == 0 {
			return
		}
		offs := v.soundOffs.Load()
		if offs == nil {
			return
		}
		if off, ok = (*offs)[trackID]; !ok {
			return
		}
		user = soundKey(sound)
	} else {
		user = sess.people[tr.GetSessionId()].userID
		off, ok = v.userOffsets[user]
		if user == "" || !ok {
			return
		}
	}
	late := time.Duration(now.UnixMicro()-(int64(captureUS)+off))*time.Microsecond + videoDecodeBudget
	a := v.adapt[user]
	if a == nil {
		a = &avAdapt{decided: now}
		v.adapt[user] = a
	}
	if len(a.lates) < 512 {
		a.lates = append(a.lates, late)
	}
	a.lastFrame = now
}

// adaptDelays applies the rule (see adaptEvery) to each person.
func (v *VideoService) adaptDelays() {
	now := v.now()
	type change struct {
		user string
		d    time.Duration
	}
	var changes []change
	v.mu.Lock()
	for user, a := range v.adapt {
		if now.Sub(a.lastFrame) > adaptIdle {
			if a.extra > 0 {
				changes = append(changes, change{user, 0})
			}
			delete(v.adapt, user)
			continue
		}
		if now.Sub(a.decided) < adaptEvery {
			continue
		}
		if !a.changed.IsZero() && now.Sub(a.changed) < adaptSettle {
			a.lates, a.decided = a.lates[:0], now // from before the change took effect
			continue
		}
		if len(a.lates) == 0 {
			continue
		}
		slices.Sort(a.lates)
		p90 := a.lates[(len(a.lates)-1)*9/10]
		want := a.extra
		switch {
		case p90 > 0:
			want += p90 + adaptMargin
		case p90 < -adaptEarly:
			want -= min(adaptEase, -p90-adaptEarly)
		}
		want = min(max(want, 0), adaptMax)
		a.lates, a.decided = a.lates[:0], now
		if want != a.extra {
			a.extra, a.changed = want, now
			changes = append(changes, change{user, want})
		}
	}
	v.mu.Unlock()
	for _, c := range changes {
		if sound, ok := soundFromKey(c.user); ok {
			if v.sounds != nil {
				v.sounds.setShareSoundDelay(sound, c.d)
			}
		} else if v.audioDelay != nil {
			v.audioDelay(c.user, c.d)
		}
	}
}

// soundKey is a share's sound's key in v.adapt (people are by user id).
func soundKey(sound uint32) string { return "\x00sound:" + strconv.FormatUint(uint64(sound), 10) }

func soundFromKey(k string) (uint32, bool) {
	n, ok := strings.CutPrefix(k, "\x00sound:")
	if !ok {
		return 0, false
	}
	v, err := strconv.ParseUint(n, 10, 32)
	return uint32(v), err == nil
}

// audioDelays is the current delay per person (tests).
func (v *VideoService) audioDelays() map[string]time.Duration {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := map[string]time.Duration{}
	for u, a := range v.adapt {
		out[u] = a.extra
	}
	return out
}

// ---- sending ----

// Cameras lists cameras to pick from (empty in builds without capture).
func (v *VideoService) Cameras() []VideoCamera {
	if v.media == nil {
		return []VideoCamera{}
	}
	cams, err := v.media.Cameras()
	if err != nil || cams == nil {
		return []VideoCamera{}
	}
	return cams
}

// ScreenSources lists screens and windows to share.
func (v *VideoService) ScreenSources() []VideoSource {
	if v.media == nil {
		return []VideoSource{}
	}
	srcs, err := v.media.Screens()
	if err != nil || srcs == nil {
		return []VideoSource{}
	}
	return srcs
}

// SetCamera turns the camera on (cameraID "" = the best one) or off.
// Turning it off while it's still starting cancels the start.
func (v *VideoService) SetCamera(on bool, cameraID string) VideoState {
	v.setShare(true, on, cameraID)
	return v.State()
}

// SetScreen starts sharing a screen or window (VideoSource.ID), or stops.
func (v *VideoService) SetScreen(on bool, sourceID string) VideoState {
	return v.ShareScreen(on, sourceID, "", false)
}

// ShareScreen starts sharing a screen or window optimized for mode
// ("detail": text, up to 1440p at 15 fps; "motion" or "": 1080p at 30 fps),
// or stops.
//
// sound: also send what the shared screen or app plays, where the share
// can (CanShareAudio).
func (v *VideoService) ShareScreen(on bool, sourceID, mode string, sound bool) VideoState {
	if mode != "detail" {
		mode = "motion"
	}
	if on {
		v.mu.Lock()
		v.st.screenMode = mode
		v.st.screenSound = sound
		v.mu.Unlock()
	}
	v.setShare(false, on, sourceID)
	return v.State()
}

// SwitchScreen shares another screen or window on the same track (the
// picker's "Switch to this"): no new tile for the others, no gap.
func (v *VideoService) SwitchScreen(sourceID string) VideoState {
	v.mu.Lock()
	share := v.st.screen.share
	v.mu.Unlock()
	sw, ok := share.(switchableShare)
	if !ok {
		v.mu.Lock()
		v.st.screen.err = "This share can't switch."
		v.dirty = true
		v.mu.Unlock()
		return v.State()
	}
	err := sw.Switch(sourceID)
	v.mu.Lock()
	if err != nil {
		v.st.screen.err = err.Error()
	} else {
		v.st.screen.id, v.st.screen.name, v.st.screen.err = sourceID, share.Name(), ""
	}
	v.dirty = true
	v.mu.Unlock()
	return v.State()
}

// ResumeCamera turns the camera back on if the user wants it on and the
// system stopped it: called when the app becomes active again (iOS,
// Android), the Mac wakes, and the webview becomes visible. A no-op
// otherwise (camera off, running, starting, or not in a call).
func (v *VideoService) ResumeCamera() VideoState {
	v.mu.Lock()
	cam := v.st.camera
	want, id := v.st.camWant, v.st.camWantID
	resume := want && v.sess != nil && v.media != nil && !cam.on && !cam.starting
	v.mu.Unlock()
	if resume {
		v.setShare(true, true, id)
	}
	return v.State()
}

// previewState is the pre-join camera preview.
type previewState struct {
	on, starting bool
	id, facing   string
	err          string
	gen          int
	stop         func()
}

// PreviewCamera shows the camera to you alone, before joining a call (id
// "" = the default camera). Nothing is encoded or sent. It stops when
// turned off, when the camera is turned on in a call, and on leaving.
func (v *VideoService) PreviewCamera(on bool, id string) VideoState {
	v.mu.Lock()
	v.pv.gen++
	gen := v.pv.gen
	stop := v.pv.stop
	v.pv = previewState{gen: gen, id: id}
	if on {
		switch {
		case v.media == nil:
			v.pv.err = "This version of the app can't use the camera."
			on = false
		case v.st.camera.on || v.st.camera.starting:
			on = false // the call's camera is the preview already
		default:
			v.pv.starting = true
		}
	}
	v.dirty = true
	v.mu.Unlock()
	if stop != nil {
		stop()
	}
	if on {
		if _, err := v.frames(); err != nil {
			v.mu.Lock()
			v.pv = previewState{gen: gen, err: err.Error()}
			v.mu.Unlock()
		} else {
			go v.runPreview(gen, id)
		}
	}
	return v.State()
}

func (v *VideoService) runPreview(gen int, id string) {
	stop, facing, err := v.media.PreviewCamera(id, v.preview, func(err error) {
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.pv.gen == gen {
			v.pv = previewState{gen: gen + 1, err: endMessage(true, err)}
			v.dirty = true
		}
	})
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.pv.gen != gen {
		if stop != nil {
			go stop() // superseded while starting
		}
		return
	}
	if err != nil {
		v.pv = previewState{gen: gen, id: id, err: err.Error()}
	} else {
		v.pv = previewState{gen: gen, id: id, on: true, facing: facing, stop: stop}
	}
	v.dirty = true
}

// stopPreview ends the pre-join preview (the call's camera takes over, or
// the call is over).
func (v *VideoService) stopPreview() {
	v.mu.Lock()
	stop := v.pv.stop
	v.pv = previewState{gen: v.pv.gen + 1}
	v.dirty = true
	v.mu.Unlock()
	if stop != nil {
		stop()
	}
}

func (v *VideoService) slot(camera bool) *shareStatus {
	if camera {
		return &v.st.camera
	}
	return &v.st.screen
}

func (v *VideoService) setShare(camera, on bool, id string) {
	v.mu.Lock()
	sl := v.slot(camera)
	sl.gen++
	gen := sl.gen
	old := sl.share
	sess := v.sess
	*sl = shareStatus{gen: gen, id: id}
	if camera {
		v.st.camWant, v.st.camWantID = on, id
	}
	previewStop := func() {}
	if camera && on && v.pv.stop != nil {
		// The call's camera replaces the pre-join preview (one device).
		stop := v.pv.stop
		v.pv = previewState{gen: v.pv.gen + 1}
		previewStop = stop
	}
	if on {
		switch {
		case v.media == nil:
			sl.err = "This version of the app can't send video."
			on = false
		case sess == nil:
			sl.err = "Not in a call."
			on = false
		case !v.st.canPublish:
			sl.err = "You can't send video in this channel."
			on = false
		default:
			sl.starting = true
		}
		if camera && !on {
			v.st.camWant = false
		}
	}
	v.dirty = true
	v.mu.Unlock()
	previewStop()
	if old != nil {
		old.Stop()
	}
	if !on {
		return
	}
	go v.runShare(camera, gen, sess, id)
}

func (v *VideoService) runShare(camera bool, gen int, sess *videoSession, id string) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Cancel the start if it's superseded (turned off, restarted, left).
	go func() {
		t := time.NewTicker(100 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				v.mu.Lock()
				stale := v.slot(camera).gen != gen || v.sess != sess
				v.mu.Unlock()
				if stale {
					cancel()
					return
				}
			}
		}
	}()
	onEnd := func(err error) {
		v.mu.Lock()
		defer v.mu.Unlock()
		sl := v.slot(camera)
		if sl.gen != gen {
			return
		}
		if camera && v.st.camWant {
			// Stopped by the system (backgrounded, asleep, taken by
			// another app): wait for ResumeCamera. The reason stays for
			// the button's title.
			*sl = shareStatus{gen: gen + 1, paused: true, id: id, err: endMessage(camera, err)}
		} else {
			*sl = shareStatus{gen: gen + 1, id: id, err: endMessage(camera, err)}
		}
		v.dirty = true
	}
	var share videoShare
	var err error
	if camera {
		share, err = v.media.StartCamera(ctx, sess.client, id, v.preview, onEnd)
	} else {
		v.mu.Lock()
		mode, sound := v.st.screenMode, v.st.screenSound && sess.canSound
		v.mu.Unlock()
		share, err = v.media.StartScreen(ctx, sess.client, id, mode, sound, onEnd)
	}
	v.mu.Lock()
	sl := v.slot(camera)
	if sl.gen != gen || v.sess != sess {
		v.mu.Unlock()
		if share != nil {
			share.Stop()
		}
		return
	}
	if err != nil {
		*sl = shareStatus{gen: gen, id: id, err: err.Error()}
		if camera {
			v.st.camWant = false // the usual camera-off reason; no retry loop
		}
	} else {
		*sl = shareStatus{gen: gen, id: id, on: true, name: share.Name(), share: share}
		if f, ok := share.(facingShare); ok {
			sl.facing = f.Facing()
		}
	}
	v.dirty = true
	v.mu.Unlock()
}

func endMessage(camera bool, err error) string {
	what := "Screen sharing"
	if camera {
		what = "The camera"
	}
	if err == nil {
		return what + " stopped."
	}
	return what + " stopped: " + err.Error()
}

func (v *VideoService) preview(w, h int, rgba []byte) {
	if hub := v.hub.Load(); hub != nil {
		hub.Preview(w, h, rgba)
	}
}

// screenSharer is media that may not share screens (iOS).
type screenSharer interface{ CanShareScreen() bool }

func (v *VideoService) canShareScreen() bool {
	if v.media == nil {
		return false
	}
	if s, ok := v.media.(screenSharer); ok {
		return s.CanShareScreen()
	}
	return true
}

// ---- state ----

func (v *VideoService) State() VideoState {
	var url string
	if hub := v.hub.Load(); hub != nil {
		url = hub.URL()
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	share := func(s shareStatus) VideoShareState {
		return VideoShareState{On: s.on, Starting: s.starting, Paused: s.paused, ID: s.id, Facing: s.facing, Name: s.name, Error: s.err}
	}
	st := VideoState{
		Available: v.st.available, Status: v.st.status, Error: v.st.err,
		CanCapture: v.media != nil, CanPublish: v.st.canPublish, CanShareScreen: v.canShareScreen(),
		CanPickScreen: v.canShareScreen() && runtime.GOOS != "linux",
		Camera:        share(v.st.camera), Screen: share(v.st.screen),
		Preview: VideoShareState{On: v.pv.on, Starting: v.pv.starting, ID: v.pv.id, Facing: v.pv.facing, Error: v.pv.err},
		Tracks:  []VideoTrack{},
	}
	if st.Screen.On || st.Screen.Starting {
		st.Screen.Mode = v.st.screenMode
	}
	if ss, ok := v.st.screen.share.(soundShare); ok && st.Screen.On {
		st.Screen.Sound = ss.SendingSound()
	}
	if s, ok := v.media.(soundSharer); ok && v.sess != nil && v.sess.canSound {
		st.CanShareAudio = st.CanPickScreen && s.CanShareSound()
	}
	if v.pv.on || v.pv.starting {
		st.FrameURL = url // the self-view's previews come over the frame socket
	}
	if !st.Available {
		return st
	}
	st.FrameURL = url
	if v.sess == nil {
		return st
	}
	for id, tr := range v.sess.tracks {
		if tr.GetKind() == videopb.TrackKind_SCREEN_AUDIO {
			continue // part of its share (VideoTrack.Sound)
		}
		p := v.sess.people[tr.GetSessionId()]
		vt := VideoTrack{TrackID: int(id), UserID: p.userID, Name: p.name, Kind: "camera",
			Self: tr.GetSessionId() == v.sess.self}
		if tr.GetKind() == videopb.TrackKind_SCREEN {
			vt.Kind = "screen"
			if !vt.Self && v.sess.soundFor(id) != 0 {
				vt.Sound = true
				vt.Volume = 100
				if p, ok := v.shareVol[id]; ok {
					vt.Volume = p
				}
			}
		}
		for _, l := range tr.GetLayers() {
			vt.Layers = append(vt.Layers, VideoLayer{ID: int(l.GetId()), Width: int(l.GetWidth()), Height: int(l.GetHeight()), FPS: int(l.GetFps())})
		}
		st.Tracks = append(st.Tracks, vt)
	}
	sort.Slice(st.Tracks, func(i, j int) bool { return st.Tracks[i].TrackID < st.Tracks[j].TrackID })
	return st
}
