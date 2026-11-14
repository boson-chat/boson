//go:build !ios && !android

package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/boson-chat/quicvoice/client"
	"github.com/boson-chat/quicvoice/gen/controlpb"
	"github.com/boson-chat/quicvoice/wire"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// VoiceService is voice channels: discovery of which servers have voice,
// their room lists, and one voice connection at a time (joining another
// room leaves the first, like Discord). Audio and the QUIC connection stay
// in Go; the renderer sends commands and draws VoiceState, which arrives as
// VoiceStateEvent events (10 Hz while in a call or testing the mic).
//
// Voice tokens come from the renderer, which holds the boson session: one
// per room list and per join (they last 5 minutes).
type VoiceService struct {
	disc     *voiceDiscoverer
	http     *http.Client
	authBase string
	dev      bool

	// newAudio opens the audio backend (cgo: miniaudio + libopus); nil or
	// failing means this build or machine can't do voice audio.
	newAudio func() (audioBackend, error)
	dial     func(ctx context.Context, cfg client.Config) (voiceConn, error)
	micAuth  func(request bool) micAccess
	emit     func(name string, data any)

	mu       sync.Mutex
	audio    audioBackend
	audioErr string
	running  bool // the audio device is open
	sess     *voiceSession
	seq      int // bumped by every Join/Leave; a superseded join gives up
	status   string
	host     string
	room     string
	roomName string
	errMsg   string
	errKind  string
	muted    bool
	deafened bool
	ptt      bool
	vadDB    float64
	inputID  string
	outputID string
	micTest  bool
	// micTestErr: why the mic test couldn't start.
	micTestErr string
	volumes    map[string]int // per user id, percent
	dirty      bool

	stop chan struct{}
	once sync.Once
}

// voiceSession is one connection to a room.
type voiceSession struct {
	conn    voiceConn
	self    uint16
	members map[uint16]*voiceMember
	left    bool // we left on purpose: its end isn't an error
}

type voiceMember struct {
	userID, name    string
	muted, deafened bool
}

// voiceConn is what VoiceService needs of a quicvoice connection
// (*client.Client), so tests can fake one.
type voiceConn interface {
	Join(ctx context.Context, room string) (*controlpb.RoomState, error)
	SetMute(muted, deafened bool) error
	SendAudio(u *wire.Uplink) error
	Ping() error
	Stats() client.Stats
	Done() <-chan struct{}
	Close() error
}

// audioBackend is the audio half: devices, capture/encode, decode/mix.
type audioBackend interface {
	Start(inputID, outputID string) error
	Stop()
	Devices() (inputs, outputs []VoiceDevice, err error)
	HandleAudio(d wire.Downlink)
	RemoveSender(sessionID uint16)
	SetSender(s voiceSender)
	SetPushToTalk(on bool)
	SetPTT(down bool)
	SetMuted(m bool)
	SetDeafened(d bool)
	SetLoopback(on bool)
	SetUserVolume(sessionID uint16, gain float32)
	SetVADThreshold(unit float32)
	Stats() audioStats
	Close()
}

type voiceSender interface {
	SendAudio(u *wire.Uplink) error
}

type audioStats struct {
	MicLevel     float32
	Transmitting bool
	Speaking     map[uint16]bool
	LossPercent  float32 // across senders
}

// VoiceDevice is an input or output device; an empty ID is the system default.
type VoiceDevice struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	IsDefault bool   `json:"isDefault"`
}

type VoiceDevices struct {
	Inputs  []VoiceDevice `json:"inputs"`
	Outputs []VoiceDevice `json:"outputs"`
	Error   string        `json:"error,omitempty"`
}

// micAccess is the OS microphone permission.
type micAccess string

const (
	micGranted      micAccess = "granted"
	micDenied       micAccess = "denied"
	micUndetermined micAccess = "undetermined"
)

// VoiceServerInfo is Discover's answer for the renderer.
type VoiceServerInfo struct {
	Host string `json:"host"`
	// Available: the server has voice the app can use with its boson
	// account (see voiceTrusted).
	Available bool   `json:"available"`
	AuthURL   string `json:"authUrl,omitempty"`
	// Audio: this build can do voice audio here (false in builds without
	// cgo); AudioError says why not.
	Audio      bool   `json:"audio"`
	AudioError string `json:"audioError,omitempty"`
}

type VoiceJoinRequest struct {
	Host     string `json:"host"`
	Room     string `json:"room"`
	RoomName string `json:"roomName"`
	Token    string `json:"token"`
}

type VoiceParticipant struct {
	SessionID int    `json:"sessionId"`
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	Self      bool   `json:"self"`
	Muted     bool   `json:"muted"`
	Deafened  bool   `json:"deafened"`
	Speaking  bool   `json:"speaking"`
	Volume    int    `json:"volume"`
}

// VoiceState is the whole voice UI state.
type VoiceState struct {
	// Status: idle | connecting | connected | error.
	Status   string `json:"status"`
	Host     string `json:"host"`
	Room     string `json:"room"`
	RoomName string `json:"roomName"`
	// ErrorKind: mic (no permission), device, token, unreachable, server,
	// dropped, unavailable.
	Error        string             `json:"error,omitempty"`
	ErrorKind    string             `json:"errorKind,omitempty"`
	Participants []VoiceParticipant `json:"participants"`
	Muted        bool               `json:"muted"`
	Deafened     bool               `json:"deafened"`
	PushToTalk   bool               `json:"pushToTalk"`
	MicTest      bool               `json:"micTest"`
	MicTestError string             `json:"micTestError,omitempty"`
	MicLevel     float32            `json:"micLevel"`
	Transmitting bool               `json:"transmitting"`
	RTTMs        float64            `json:"rttMs"`
	LossPercent  float32            `json:"lossPercent"`
	// Quality: good | ok | poor | unknown.
	Quality    string `json:"quality"`
	AudioError string `json:"audioError,omitempty"`
}

const (
	VoiceStateEvent  = "voice:state"
	voiceDialTimeout = 8 * time.Second
	defaultVADDB     = -45
)

func init() {
	application.RegisterEvent[VoiceState](VoiceStateEvent)
}

func NewVoiceService(dataDir, authBase string, dev bool) *VoiceService {
	return &VoiceService{
		disc:     newVoiceDiscoverer(dataDir, dev),
		http:     &http.Client{Timeout: voiceRoomsTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		authBase: authBase,
		dev:      dev,
		newAudio: newAudioBackend,
		dial: func(ctx context.Context, cfg client.Config) (voiceConn, error) {
			return client.Dial(ctx, cfg)
		},
		micAuth: micPermission,
		status:  "idle",
		vadDB:   defaultVADDB,
		volumes: map[string]int{},
		stop:    make(chan struct{}),
	}
}

func (s *VoiceService) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	go s.stateLoop()
	return nil
}

func (s *VoiceService) ServiceShutdown() error {
	s.once.Do(func() { close(s.stop) })
	s.Leave()
	s.mu.Lock()
	a := s.audio
	s.audio = nil
	s.mu.Unlock()
	if a != nil {
		a.Close()
	}
	return nil
}

func (s *VoiceService) send(name string, data any) {
	if s.emit != nil {
		s.emit(name, data)
		return
	}
	if app := application.Get(); app != nil {
		app.Event.Emit(name, data)
	}
}

// ---- discovery and rooms ----

// Discover says whether host (an IRC server's hostname) has voice the app
// can use. refresh re-checks rather than answering from the day-long cache.
func (s *VoiceService) Discover(host string, refresh bool) VoiceServerInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 3*voiceDiscoveryTimeout)
	defer cancel()
	d := s.disc.Discover(ctx, host, refresh)
	out := VoiceServerInfo{Host: d.Host}
	if d.Voice != nil {
		out.AuthURL = d.Voice.AuthURL
		out.Available = voiceTrusted(d.Voice, s.authBase, s.dev)
	}
	if out.Available {
		out.Audio = voiceAudioCompiled
		if !out.Audio {
			out.AudioError = errVoiceAudioUnavailable.Error()
		}
	}
	return out
}

// trustedVoice is host's voice server, if the app may use it.
func (s *VoiceService) trustedVoice(host string) *VoiceInfo {
	d := s.disc.cached(host)
	if d == nil || !voiceTrusted(d.Voice, s.authBase, s.dev) {
		return nil
	}
	return d.Voice
}

// Rooms lists host's voice channels, with a voice token from the renderer.
func (s *VoiceService) Rooms(host, token string) VoiceRoomsResult {
	info := s.trustedVoice(host)
	if info == nil {
		return VoiceRoomsResult{Error: "This server has no voice channels.", ErrorKind: "unavailable"}
	}
	if token == "" {
		return VoiceRoomsResult{Error: "Sign in to use voice.", ErrorKind: "token"}
	}
	return fetchVoiceRooms(context.Background(), s.http, info.URL, token)
}

// ---- audio ----

func (s *VoiceService) ensureAudio() (audioBackend, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.audio != nil {
		return s.audio, nil
	}
	if s.audioErr != "" {
		return nil, errors.New(s.audioErr)
	}
	if s.newAudio == nil {
		s.audioErr = errVoiceAudioUnavailable.Error()
		return nil, errVoiceAudioUnavailable
	}
	a, err := s.newAudio()
	if err != nil {
		s.audioErr = err.Error()
		return nil, err
	}
	a.SetVADThreshold(dbToUnit(s.vadDB))
	a.SetPushToTalk(s.ptt)
	a.SetMuted(s.muted || s.deafened)
	a.SetDeafened(s.deafened)
	s.audio = a
	return a, nil
}

// startAudio opens the device if it isn't, after checking the OS mic
// permission. Returns the error kind and message on failure.
func (s *VoiceService) startAudio() (kind, msg string) {
	a, err := s.ensureAudio()
	if err != nil {
		return "unavailable", "Voice isn't available in this build: " + err.Error()
	}
	if s.micAuth != nil {
		switch s.micAuth(true) {
		case micDenied:
			return "mic", "Boson can't use your microphone. Allow it in your system's privacy settings, then try again."
		}
	}
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return "", ""
	}
	in, out := s.inputID, s.outputID
	s.mu.Unlock()
	if err := a.Start(in, out); err != nil {
		low := strings.ToLower(err.Error())
		if strings.Contains(low, "denied") || strings.Contains(low, "permission") || strings.Contains(low, "access") {
			return "mic", "Boson can't use your microphone. Allow it in your system's privacy settings, then try again."
		}
		return "device", "Couldn't open your audio device: " + err.Error()
	}
	s.mu.Lock()
	s.running = true
	s.mu.Unlock()
	return "", ""
}

// stopAudioIfIdle closes the device when nothing needs it, so the mic
// indicator goes off.
func (s *VoiceService) stopAudioIfIdle() {
	s.mu.Lock()
	idle := s.sess == nil && !s.micTest && s.status != "connecting"
	a := s.audio
	if idle && s.running && a != nil {
		s.running = false
	} else {
		a = nil
	}
	s.mu.Unlock()
	if a != nil {
		a.Stop()
	}
}

// Devices lists the audio devices.
func (s *VoiceService) Devices() VoiceDevices {
	a, err := s.ensureAudio()
	if err != nil {
		return VoiceDevices{Error: err.Error()}
	}
	in, out, err := a.Devices()
	if err != nil {
		return VoiceDevices{Error: err.Error()}
	}
	return VoiceDevices{Inputs: in, Outputs: out}
}

// SetDevices picks the mic and speakers ("" = system default); a running
// device switches now.
func (s *VoiceService) SetDevices(inputID, outputID string) string {
	s.mu.Lock()
	changed := s.inputID != inputID || s.outputID != outputID
	s.inputID, s.outputID = inputID, outputID
	running, a := s.running, s.audio
	s.mu.Unlock()
	if !changed || !running || a == nil {
		return ""
	}
	if err := a.Start(inputID, outputID); err != nil {
		s.mu.Lock()
		s.running = false
		s.errMsg, s.errKind = "Couldn't switch audio devices: "+err.Error(), "device"
		s.dirty = true
		s.mu.Unlock()
		return err.Error()
	}
	return ""
}

// MicTest plays your own voice back to you (through the encoder, as others
// would hear it). Opens the device if nothing else has.
func (s *VoiceService) MicTest(on bool) VoiceState {
	if on {
		if kind, msg := s.startAudio(); kind != "" {
			s.mu.Lock()
			s.micTestErr = msg
			s.dirty = true
			s.mu.Unlock()
			return s.State()
		}
	}
	s.mu.Lock()
	s.micTest = on
	s.micTestErr = ""
	a := s.audio
	s.dirty = true
	s.mu.Unlock()
	if a != nil {
		a.SetLoopback(on)
		if !on {
			a.RemoveSender(loopbackSession)
		}
	}
	if !on {
		s.stopAudioIfIdle()
	}
	return s.State()
}

// loopbackSession is quicvoice's voice.LoopbackSession.
const loopbackSession = 0

// ---- joining ----

// Join connects to host's voice server and enters a room, leaving any
// other room first. The token is a fresh voice token for that room.
func (s *VoiceService) Join(req VoiceJoinRequest) VoiceState {
	info := s.trustedVoice(req.Host)
	if info == nil {
		s.fail(0, "unavailable", "This server has no voice channels.")
		return s.State()
	}
	if req.Room == "" {
		s.fail(0, "server", "No voice channel given.")
		return s.State()
	}
	if req.Token == "" {
		s.fail(0, "token", "Sign in to use voice.")
		return s.State()
	}
	s.Leave()

	s.mu.Lock()
	s.seq++
	seq := s.seq
	s.status, s.host, s.room, s.roomName = "connecting", strings.ToLower(req.Host), req.Room, firstNonEmpty(req.RoomName, req.Room)
	s.errMsg, s.errKind = "", ""
	s.dirty = true
	s.mu.Unlock()

	if kind, msg := s.startAudio(); kind != "" {
		s.fail(seq, kind, msg)
		return s.State()
	}
	a, _ := s.ensureAudio()

	sess := &voiceSession{members: map[uint16]*voiceMember{}}
	ctx, cancel := context.WithTimeout(context.Background(), voiceDialTimeout)
	defer cancel()
	addrHost, _, _ := net.SplitHostPort(info.Addr)
	conn, err := s.dial(ctx, client.Config{
		Addr:  info.Addr,
		Token: req.Token,
		// A local quicvoiced (dev builds) has a self-signed certificate.
		InsecureSkipVerify: s.dev && isLoopbackHost(addrHost),
		OnAudio:            a.HandleAudio,
		OnControl:          func(m *controlpb.ControlMessage) { s.onControl(sess, m) },
	})
	if err != nil {
		kind, msg := classifyVoiceError(err, true)
		s.fail(seq, kind, msg)
		return s.State()
	}
	state, err := conn.Join(ctx, req.Room)
	if err != nil {
		_ = conn.Close()
		kind, msg := classifyVoiceError(err, false)
		s.fail(seq, kind, msg)
		return s.State()
	}

	s.mu.Lock()
	if s.seq != seq {
		// Left, or joined elsewhere, while this was connecting.
		s.mu.Unlock()
		_ = conn.Close()
		return s.State()
	}
	sess.conn = conn
	sess.self = uint16(state.GetYourSessionId())
	for _, p := range state.GetParticipants() {
		sess.members[uint16(p.GetSessionId())] = memberFrom(p)
	}
	s.sess = sess
	s.status = "connected"
	if r := state.GetRoom(); r != "" {
		s.room = r
	}
	muted, deafened := s.muted, s.deafened
	s.applyVolumesLocked(sess)
	s.dirty = true
	s.mu.Unlock()

	a.SetSender(conn)
	if muted || deafened {
		_ = conn.SetMute(muted || deafened, deafened)
	}
	go s.watch(sess)
	return s.State()
}

// Leave hangs up. Safe to call when not connected.
func (s *VoiceService) Leave() {
	s.mu.Lock()
	s.seq++
	sess := s.sess
	s.sess = nil
	if sess != nil {
		sess.left = true
	}
	a := s.audio
	if s.status != "error" || sess != nil {
		s.status, s.errMsg, s.errKind = "idle", "", ""
	}
	s.host, s.room, s.roomName = "", "", ""
	s.dirty = true
	s.mu.Unlock()
	if sess != nil {
		if a != nil {
			a.SetSender(nil)
			for sid := range sess.members {
				a.RemoveSender(sid)
			}
		}
		_ = sess.conn.Close()
	}
	s.stopAudioIfIdle()
}

// DismissError clears an error state.
func (s *VoiceService) DismissError() {
	s.mu.Lock()
	if s.status == "error" {
		s.status, s.host, s.room, s.roomName = "idle", "", "", ""
	}
	s.errMsg, s.errKind = "", ""
	s.dirty = true
	s.mu.Unlock()
}

func (s *VoiceService) fail(seq int, kind, msg string) {
	s.mu.Lock()
	if seq != 0 && s.seq != seq {
		s.mu.Unlock()
		return
	}
	s.status, s.errMsg, s.errKind = "error", msg, kind
	s.dirty = true
	s.mu.Unlock()
	s.stopAudioIfIdle()
}

// classifyVoiceError turns a dial/join error into a kind and a sentence.
func classifyVoiceError(err error, dialing bool) (kind, msg string) {
	e := err.Error()
	switch {
	case strings.Contains(e, "UNAUTHENTICATED"), strings.Contains(e, "TOKEN_EXPIRED"):
		return "token", "The voice server didn't accept your sign-in. Try again."
	case strings.Contains(e, "FORBIDDEN"), strings.Contains(e, "BANNED"):
		return "server", "You're not allowed in this voice channel."
	case strings.Contains(e, "ROOM_FULL"):
		return "server", "This voice channel is full."
	case strings.Contains(e, "ROOM_NOT_FOUND"):
		return "server", "This voice channel doesn't exist any more."
	case strings.Contains(e, "server:"):
		return "server", "The voice server refused: " + strings.TrimPrefix(e[strings.Index(e, "server:"):], "server: ")
	case dialing, errors.Is(err, context.DeadlineExceeded):
		return "unreachable", "Couldn't reach the voice server. Check your connection and try again."
	default:
		return "server", "Voice failed: " + e
	}
}

// watch pings for RTT and notices the connection ending.
func (s *VoiceService) watch(sess *voiceSession) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	_ = sess.conn.Ping()
	for {
		select {
		case <-t.C:
			_ = sess.conn.Ping()
		case <-s.stop:
			return
		case <-sess.conn.Done():
			s.mu.Lock()
			current := s.sess == sess
			a := s.audio
			if current {
				s.sess = nil
				s.status, s.errMsg, s.errKind = "error", "Lost the connection to the voice server.", "dropped"
				s.dirty = true
			}
			s.mu.Unlock()
			if current && a != nil {
				a.SetSender(nil)
				for sid := range sess.members {
					a.RemoveSender(sid)
				}
			}
			if current {
				s.stopAudioIfIdle()
			}
			return
		}
	}
}

func (s *VoiceService) onControl(sess *voiceSession, m *controlpb.ControlMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case m.GetParticipantJoined() != nil:
		p := m.GetParticipantJoined().GetParticipant()
		sid := uint16(p.GetSessionId())
		sess.members[sid] = memberFrom(p)
		if v, ok := s.volumes[p.GetUserId()]; ok && s.audio != nil && s.sess == sess {
			s.audio.SetUserVolume(sid, float32(v)/100)
		}
	case m.GetParticipantLeft() != nil:
		sid := uint16(m.GetParticipantLeft().GetSessionId())
		delete(sess.members, sid)
		if s.audio != nil && s.sess == sess {
			s.audio.RemoveSender(sid)
		}
	case m.GetParticipantUpdated() != nil:
		p := m.GetParticipantUpdated().GetParticipant()
		sess.members[uint16(p.GetSessionId())] = memberFrom(p)
	case m.GetError() != nil && m.GetError().GetFatal():
		if s.sess == sess {
			_, msg := classifyVoiceError(errors.New("server: "+m.GetError().GetCode().String()+": "+m.GetError().GetMessage()), false)
			s.errMsg = msg
		}
	}
	s.dirty = true
}

func memberFrom(p *controlpb.Participant) *voiceMember {
	return &voiceMember{
		userID:   p.GetUserId(),
		name:     p.GetDisplayName(),
		muted:    p.GetSelfMuted() || p.GetServerMuted(),
		deafened: p.GetDeafened(),
	}
}

// ---- controls ----

func (s *VoiceService) SetMuted(muted bool) VoiceState { return s.setMute(&muted, nil) }

func (s *VoiceService) SetDeafened(deafened bool) VoiceState { return s.setMute(nil, &deafened) }

func (s *VoiceService) setMute(muted, deafened *bool) VoiceState {
	s.mu.Lock()
	if muted != nil {
		s.muted = *muted
		// Unmuting while deafened undeafens too, like Discord.
		if !*muted && s.deafened {
			s.deafened = false
		}
	}
	if deafened != nil {
		s.deafened = *deafened
	}
	m, d, a := s.muted, s.deafened, s.audio
	var c voiceConn
	if s.sess != nil {
		c = s.sess.conn
	}
	s.dirty = true
	s.mu.Unlock()
	// Deafened implies muted.
	if a != nil {
		a.SetMuted(m || d)
		a.SetDeafened(d)
	}
	if c != nil {
		_ = c.SetMute(m || d, d)
	}
	return s.State()
}

// SetInputMode: "vad" (voice activity) or "ptt" (push to talk).
func (s *VoiceService) SetInputMode(mode string) {
	ptt := mode == "ptt"
	s.mu.Lock()
	s.ptt = ptt
	a := s.audio
	s.dirty = true
	s.mu.Unlock()
	if a != nil {
		a.SetPushToTalk(ptt)
		a.SetPTT(false)
	}
}

// PTT is the push-to-talk key going down or up.
func (s *VoiceService) PTT(down bool) {
	s.mu.Lock()
	a := s.audio
	s.mu.Unlock()
	if a != nil {
		a.SetPTT(down)
	}
}

// SetVADThreshold sets the level (dBFS, -60..0) above which voice activity
// transmits.
func (s *VoiceService) SetVADThreshold(db float64) {
	db = max(-60, min(0, db))
	s.mu.Lock()
	s.vadDB = db
	a := s.audio
	s.mu.Unlock()
	if a != nil {
		a.SetVADThreshold(dbToUnit(db))
	}
}

func dbToUnit(db float64) float32 { return float32(max(0, min(1, 1+db/60))) }

// SetUserVolume sets how loud a user (by account id) plays, 0..200 %. It
// sticks for this run; the renderer keeps it across runs.
func (s *VoiceService) SetUserVolume(userID string, percent int) {
	if userID == "" {
		return
	}
	percent = max(0, min(200, percent))
	s.mu.Lock()
	s.volumes[userID] = percent
	if s.sess != nil {
		s.applyVolumesLocked(s.sess)
	}
	s.dirty = true
	s.mu.Unlock()
}

func (s *VoiceService) applyVolumesLocked(sess *voiceSession) {
	if s.audio == nil {
		return
	}
	for sid, m := range sess.members {
		if v, ok := s.volumes[m.userID]; ok {
			s.audio.SetUserVolume(sid, float32(v)/100)
		}
	}
}

// ---- state ----

func (s *VoiceService) State() VoiceState {
	s.mu.Lock()
	a := s.audio
	s.mu.Unlock()
	var es audioStats
	if a != nil {
		es = a.Stats()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	st := VoiceState{
		Status: s.status, Host: s.host, Room: s.room, RoomName: s.roomName,
		Error: s.errMsg, ErrorKind: s.errKind,
		Participants: []VoiceParticipant{},
		Muted:        s.muted, Deafened: s.deafened, PushToTalk: s.ptt, MicTest: s.micTest, MicTestError: s.micTestErr,
		Quality: "unknown", AudioError: s.audioErr,
	}
	if s.running {
		st.MicLevel, st.Transmitting = es.MicLevel, es.Transmitting
	}
	if s.sess == nil {
		return st
	}
	cs := s.sess.conn.Stats()
	st.RTTMs = float64(cs.RTT.Microseconds()) / 1000
	st.LossPercent = es.LossPercent
	st.Quality = voiceQuality(cs.RTT, es.LossPercent)
	for sid, m := range s.sess.members {
		p := VoiceParticipant{
			SessionID: int(sid), UserID: m.userID, Name: m.name, Self: sid == s.sess.self,
			Muted: m.muted, Deafened: m.deafened, Volume: 100,
		}
		if v, ok := s.volumes[m.userID]; ok {
			p.Volume = v
		}
		if p.Self {
			p.Muted, p.Deafened = s.muted || s.deafened, s.deafened
			p.Speaking = es.Transmitting
		} else {
			p.Speaking = es.Speaking[sid]
		}
		st.Participants = append(st.Participants, p)
	}
	sort.Slice(st.Participants, func(i, j int) bool {
		return st.Participants[i].SessionID < st.Participants[j].SessionID
	})
	return st
}

func voiceQuality(rtt time.Duration, loss float32) string {
	switch {
	case rtt == 0:
		return "unknown"
	case rtt < 120*time.Millisecond && loss < 2:
		return "good"
	case rtt < 300*time.Millisecond && loss < 8:
		return "ok"
	default:
		return "poor"
	}
}

// stateLoop pushes the state 10 times a second while there's something
// live (a call, the mic test), and otherwise only when it changes.
func (s *VoiceService) stateLoop() {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			s.mu.Lock()
			live := s.sess != nil || s.micTest || s.status == "connecting"
			push := live || s.dirty
			s.dirty = false
			s.mu.Unlock()
			if push {
				s.send(VoiceStateEvent, s.State())
			}
		}
	}
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
