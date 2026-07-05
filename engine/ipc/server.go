// Package ipc exposes the engine to the Electron renderer over a localhost
// WebSocket. Each WebSocket connection can own multiple concurrent IRC
// sessions — one per serverId minted by the renderer. A connect command
// registers a new IRC client under the given serverId, and closing the
// WebSocket quits every client owned by that session.
package ipc

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	stdhttp "net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/boson-chat/boson/engine/irc"

	"github.com/coder/websocket"
)

type Server struct {
	addr  string
	token string
	mux   *stdhttp.ServeMux
}

func NewServer(addr, token string) *Server {
	s := &Server{addr: addr, token: token, mux: stdhttp.NewServeMux()}
	s.mux.HandleFunc("/ws", s.handleWS)
	s.mux.HandleFunc("/health", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	return s
}

func (s *Server) Token() string { return s.token }

// ListenAndServe blocks until ctx is cancelled.
func (s *Server) ListenAndServe(ctx context.Context) error {
	srv := &stdhttp.Server{
		Addr:              s.addr,
		Handler:           s.mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
		return nil
	case err := <-errCh:
		return err
	}
}

func (s *Server) handleWS(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	if !s.authorize(r) {
		stdhttp.Error(w, "unauthorized", stdhttp.StatusUnauthorized)
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Localhost-only listener — but be explicit. Electron renderer
		// loads via file://, vite dev uses localhost, so allow those.
		OriginPatterns: []string{"http://localhost:*", "http://127.0.0.1:*", "file://*"},
	})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	sess := newSession(c)
	sess.run(r.Context())
}

func (s *Server) authorize(r *stdhttp.Request) bool {
	got := r.URL.Query().Get("token")
	if got == "" {
		got = stripBearer(r.Header.Get("Authorization"))
	}
	if got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func stripBearer(h string) string {
	const p = "Bearer "
	if len(h) > len(p) && h[:len(p)] == p {
		return h[len(p):]
	}
	return ""
}

// ----- per-connection session -----

// engineClient is the per-server bundle the session map stores. cancel kills
// the IRC client's context — triggered on disconnect or session shutdown.
type engineClient struct {
	client *irc.Client
	cancel context.CancelFunc
}

type session struct {
	ws *websocket.Conn

	// ctx bounds the session lifetime; set once at the top of run() before
	// any IRC client (and thus any send) can exist. Read by send() so a
	// blocked write unblocks on shutdown instead of hanging.
	ctx context.Context

	mu      sync.Mutex
	clients map[string]*engineClient
	out     chan ServerMessage
}

func newSession(ws *websocket.Conn) *session {
	// Buffer sized to comfortably absorb a NAMREPLY burst for a busy channel
	// without dropping events. The renderer reads them serially; a small
	// buffer used to cause silent loss when joining several channels at once.
	return &session{
		ws:      ws,
		clients: make(map[string]*engineClient),
		out:     make(chan ServerMessage, 1024),
	}
}

func (s *session) run(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.ctx = ctx
	go s.writeLoop(ctx)

	for {
		_, data, err := s.ws.Read(ctx)
		if err != nil {
			s.shutdownAll()
			return
		}
		var msg ClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad json: " + err.Error()})
			continue
		}
		s.dispatch(ctx, msg)
	}
}

func (s *session) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-s.out:
			raw, err := json.Marshal(msg)
			if err != nil {
				continue
			}
			if err := s.ws.Write(ctx, websocket.MessageText, raw); err != nil {
				return
			}
		}
	}
}

func (s *session) send(msg ServerMessage) {
	// Fast path: room in the buffer, enqueue without blocking.
	select {
	case s.out <- msg:
		return
	default:
	}
	// Backpressure: the buffer (1024) is full. Silently dropping here loses
	// IRC state (JOIN/PART/NAMES/PRIVMSG) and leaves the renderer's channel
	// view permanently inconsistent until a manual refresh, so we block for
	// a bounded window instead. If the writer is still wedged after that the
	// websocket is effectively dead — drop rather than stall the IRC reader
	// forever; closing ctx (session teardown) also unblocks us immediately.
	ctx := s.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	t := time.NewTimer(5 * time.Second)
	defer t.Stop()
	select {
	case s.out <- msg:
	case <-ctx.Done():
	case <-t.C:
	}
}

func (s *session) dispatch(ctx context.Context, msg ClientMessage) {
	switch msg.Type {
	case CmdConnect:
		var p ConnectParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad connect params: " + err.Error()})
			return
		}
		if p.ServerID == "" {
			s.send(ServerMessage{Type: MsgError, Error: "connect: serverId is required"})
			return
		}
		s.handleConnect(ctx, p)
	case CmdDisconnect:
		var p DisconnectParams
		if len(msg.Params) > 0 {
			if err := json.Unmarshal(msg.Params, &p); err != nil {
				s.send(ServerMessage{Type: MsgError, Error: "bad disconnect params: " + err.Error()})
				return
			}
		}
		if p.ServerID == "" {
			s.send(ServerMessage{Type: MsgError, Error: "disconnect: serverId is required"})
			return
		}
		s.shutdownIRC(p.ServerID)
		s.send(ServerMessage{Type: MsgStatus, ServerID: p.ServerID, State: StateDisconnected})
	case CmdJoin:
		var p JoinParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad join params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.Join(p.Channel)
		}
	case CmdPart:
		var p JoinParams // PART uses the same shape (a channel)
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad part params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.Part(p.Channel)
		}
	case CmdPrivmsg:
		var p PrivmsgParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad privmsg params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.Privmsg(p.Target, p.Message)
		}
	case CmdNames:
		var p NamesParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad names params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.Names(p.Channel)
		}
	case CmdTagmsg:
		var p TagmsgParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad tagmsg params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.Tagmsg(p.Target, p.Tags)
		}
	case CmdList:
		var p ListParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad list params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.List()
		}
	case CmdAway:
		var p AwayParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad away params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.Away(p.Message)
		}
	case CmdNick:
		var p NickParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad nick params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.Nick(p.Nick)
		}
	case CmdNickservIdentify:
		var p NickservIdentifyParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad nickserv-identify params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.NickservIdentify(p.Password)
		}
	case CmdRaw:
		var p RawParams
		if err := json.Unmarshal(msg.Params, &p); err != nil {
			s.send(ServerMessage{Type: MsgError, Error: "bad raw params: " + err.Error()})
			return
		}
		if c := s.clientFor(p.ServerID); c != nil {
			c.SendRaw(p.Line)
		}
	default:
		s.send(ServerMessage{Type: MsgError, Error: "unknown command: " + msg.Type})
	}
}

func (s *session) handleConnect(ctx context.Context, p ConnectParams) {
	// Idempotent at the engine layer: if the renderer already has a client
	// for this serverId, reject the duplicate. The renderer owns the
	// "already-connected, just reuse it" path locally; the engine guards
	// against double-spawn so a second connect can't leak a goroutine.
	s.mu.Lock()
	if _, exists := s.clients[p.ServerID]; exists {
		s.mu.Unlock()
		s.send(ServerMessage{
			Type:     MsgError,
			ServerID: p.ServerID,
			Error:    "connect: server " + p.ServerID + " already connected",
		})
		return
	}
	s.mu.Unlock()

	cfg := irc.Config{
		Hostname:         p.Hostname,
		Port:             p.Port,
		TLS:              p.TLS,
		Nick:             p.Nick,
		NickservPassword: p.NickservPassword,
		ServerPass:       p.ServerPass,
		TLSInsecure:      p.TLSInsecure,
	}
	if p.SASL != nil {
		cfg.SASL = &irc.SASLPlain{User: p.SASL.User, Password: p.SASL.Password}
	}

	client, err := irc.New(cfg)
	if err != nil {
		s.send(ServerMessage{Type: MsgError, ServerID: p.ServerID, Error: err.Error()})
		return
	}
	serverID := p.ServerID
	client.OnChannelDirectory(func(entries []irc.ChannelDirectoryEntry) {
		// Engine accumulates 322/323 internally; we ship the renderer one
		// atomic update per LIST cycle so it doesn't have to do protocol
		// bookkeeping. Auto-fired ~2.5s after RPL_WELCOME and on demand.
		s.send(ServerMessage{Type: MsgChannelDirectory, ServerID: serverID, Directory: entries})
	})
	// Services-framework verdicts (atheme/anope/unknown). Fires once
	// per detection transition. Renderer keeps its own copy in
	// ChatState and renders the Advanced panel's badge from it.
	client.OnServices(func(fw irc.ServicesFramework) {
		s.send(ServerMessage{
			Type:      MsgServicesFramework,
			ServerID:  serverID,
			Framework: string(fw),
		})
	})
	client.OnEvent(func(e irc.Event) {
		ev := e
		s.send(ServerMessage{Type: MsgEvent, ServerID: serverID, Event: &ev})
		if e.Kind == "001" { // RPL_WELCOME
			s.send(ServerMessage{Type: MsgStatus, ServerID: serverID, State: StateConnected})
			return
		}
		// IRC error numerics during/after registration (4xx, 5xx) — forward as
		// a session error so the renderer surfaces a real reason instead of
		// sitting on "connecting...". Common: 432 ERR_ERRONEUSNICKNAME,
		// 433 ERR_NICKNAMEINUSE, 464 ERR_PASSWDMISMATCH, 465 YOUREBANNEDCREEP.
		if len(e.Kind) == 3 && (e.Kind[0] == '4' || e.Kind[0] == '5') {
			msg := e.Message
			if msg == "" {
				msg = "IRC error " + e.Kind
			} else {
				msg = e.Kind + ": " + msg
			}
			s.send(ServerMessage{Type: MsgError, ServerID: serverID, Error: msg})
		}
	})

	ircCtx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	// Race window: another connect for the same serverId could have raced
	// the unlock-relock. Reject and bail without leaking the new client.
	if _, exists := s.clients[serverID]; exists {
		s.mu.Unlock()
		cancel()
		s.send(ServerMessage{
			Type:     MsgError,
			ServerID: serverID,
			Error:    "connect: server " + serverID + " already connected",
		})
		return
	}
	s.clients[serverID] = &engineClient{client: client, cancel: cancel}
	s.mu.Unlock()

	log.Printf("[engine] connect serverID=%s host=%s port=%d tls=%t nick=%s",
		serverID, p.Hostname, p.Port, p.TLS, p.Nick)
	s.send(ServerMessage{Type: MsgStatus, ServerID: serverID, State: StateConnecting})

	go func() {
		err := client.Connect(ircCtx)
		if err != nil {
			log.Printf("[engine] connect serverID=%s ended with error: %v", serverID, err)
			s.send(ServerMessage{Type: MsgError, ServerID: serverID, Error: err.Error()})
		} else {
			log.Printf("[engine] connect serverID=%s ended cleanly (no error)", serverID)
		}
		// Mark the slot empty BEFORE emitting disconnected so a follow-up
		// connect for the same serverId from the renderer doesn't collide.
		s.mu.Lock()
		if ec, ok := s.clients[serverID]; ok && ec.client == client {
			delete(s.clients, serverID)
		}
		s.mu.Unlock()
		s.send(ServerMessage{Type: MsgStatus, ServerID: serverID, State: StateDisconnected})
	}()
}

func (s *session) clientFor(serverID string) *irc.Client {
	if serverID == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ec, ok := s.clients[serverID]
	if !ok {
		return nil
	}
	return ec.client
}

// shutdownIRC tears down a single named IRC client and removes it from the
// session map. The Connect goroutine emits the StateDisconnected after the
// context is cancelled — disconnect itself just kicks the context.
func (s *session) shutdownIRC(serverID string) {
	s.mu.Lock()
	ec, ok := s.clients[serverID]
	if ok {
		delete(s.clients, serverID)
	}
	s.mu.Unlock()
	if ok && ec.cancel != nil {
		ec.cancel()
	}
}

// shutdownAll tears down every IRC client owned by this session. Called when
// the WebSocket closes.
func (s *session) shutdownAll() {
	s.mu.Lock()
	clients := s.clients
	s.clients = make(map[string]*engineClient)
	s.mu.Unlock()
	for _, ec := range clients {
		if ec.cancel != nil {
			ec.cancel()
		}
	}
}

// ----- discovery file -----

type Discovery struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

// WriteDiscovery writes the engine's connection info to a file Electron can read.
// Default path: $XDG_RUNTIME_DIR/boson/engine.json, falling back to ~/.boson/engine.json.
func WriteDiscovery(path, wsURL, token string) error {
	if path == "" {
		path = DefaultDiscoveryPath()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	d := Discovery{URL: wsURL, Token: token, PID: os.Getpid()}
	raw, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0o600)
}

func DefaultDiscoveryPath() string {
	if v := os.Getenv("XDG_RUNTIME_DIR"); v != "" {
		return filepath.Join(v, "boson", "engine.json")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".boson", "engine.json")
}

// GenerateToken returns a base64 random token suitable for the WebSocket
// authorization handshake.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// BuildWSURL helps construct the connection URL clients should use.
func BuildWSURL(addr string) (string, error) {
	if addr == "" {
		return "", errors.New("addr is required")
	}
	u := &url.URL{Scheme: "ws", Host: addr, Path: "/ws"}
	return u.String(), nil
}
