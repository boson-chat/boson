package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeIRCServer is a minimal IRC server that accepts a single connection and
// drives the girc client through the registration handshake just far enough
// to emit RPL_WELCOME (numeric 001) so the engine flips state to "connected".
// One instance per test client. Use newFakeIRCServer / Close from each test.
type fakeIRCServer struct {
	listener net.Listener
	addr     string
	port     int

	mu        sync.Mutex
	conns     []net.Conn
	connected chan struct{} // closed once the welcome handshake completes
	closeOnce sync.Once
}

func newFakeIRCServer(t *testing.T) *fakeIRCServer {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := l.Addr().(*net.TCPAddr).Port
	srv := &fakeIRCServer{
		listener:  l,
		addr:      "127.0.0.1",
		port:      port,
		connected: make(chan struct{}),
	}
	go srv.acceptLoop()
	t.Cleanup(srv.Close)
	return srv
}

func (f *fakeIRCServer) acceptLoop() {
	for {
		conn, err := f.listener.Accept()
		if err != nil {
			return
		}
		f.mu.Lock()
		f.conns = append(f.conns, conn)
		f.mu.Unlock()
		go f.handle(conn)
	}
}

func (f *fakeIRCServer) handle(conn net.Conn) {
	defer conn.Close()
	rd := bufio.NewReader(conn)
	var nick string
	welcomeSent := false
	for {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "NICK "):
			nick = strings.TrimSpace(strings.TrimPrefix(line, "NICK "))
		case strings.HasPrefix(line, "USER "):
			if nick == "" {
				nick = "anon"
			}
			// Send RPL_WELCOME (001) to complete registration.
			_, _ = fmt.Fprintf(conn, ":fake.irc 001 %s :Welcome %s\r\n", nick, nick)
			welcomeSent = true
			f.signalConnected()
		case strings.HasPrefix(line, "PING "):
			payload := strings.TrimSpace(strings.TrimPrefix(line, "PING "))
			_, _ = fmt.Fprintf(conn, "PONG %s\r\n", payload)
		case strings.HasPrefix(line, "QUIT"):
			return
		case strings.HasPrefix(line, "PRIVMSG"):
			// Echo back as PRIVMSG from "echo" so the engine emits an event
			// the test can observe.
			if !welcomeSent {
				continue
			}
			parts := strings.SplitN(strings.TrimPrefix(line, "PRIVMSG "), " ", 2)
			if len(parts) < 2 {
				continue
			}
			target := parts[0]
			msg := strings.TrimPrefix(parts[1], ":")
			_, _ = fmt.Fprintf(conn, ":echo PRIVMSG %s :%s\r\n", target, msg)
		}
	}
}

func (f *fakeIRCServer) signalConnected() {
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.connected:
		// Already closed for an earlier connection.
	default:
		close(f.connected)
	}
}

func (f *fakeIRCServer) Close() {
	f.closeOnce.Do(func() {
		_ = f.listener.Close()
		f.mu.Lock()
		conns := f.conns
		f.conns = nil
		f.mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
	})
}

// readUntil reads server messages until pred matches or the deadline expires.
// Returns the full list of messages observed so the caller can assert on
// ordering.
func readUntil(t *testing.T, c readJSONer, pred func(ServerMessage) bool) []ServerMessage {
	t.Helper()
	var out []ServerMessage
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		msg, ok := c.readWithTimeout(t, 500*time.Millisecond)
		if !ok {
			continue
		}
		out = append(out, msg)
		if pred(msg) {
			return out
		}
	}
	t.Fatalf("readUntil: predicate never matched. observed=%d", len(out))
	return out
}

// readJSONer abstracts away the websocket.Conn so test helpers don't have to
// know the wire protocol.
type readJSONer interface {
	readWithTimeout(t *testing.T, d time.Duration) (ServerMessage, bool)
}

func wrapConn(read func(ctx context.Context) (ServerMessage, bool)) readJSONer {
	return &readerFunc{read: read}
}

type readerFunc struct {
	read func(ctx context.Context) (ServerMessage, bool)
}

func (r *readerFunc) readWithTimeout(t *testing.T, d time.Duration) (ServerMessage, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	return r.read(ctx)
}

func TestSession_TwoConcurrentClients_EventsRoutedByServerID(t *testing.T) {
	// Two fake IRC servers backing two separate engine clients on the same
	// WebSocket session. Each PRIVMSG echo must carry the originating serverId.
	irc1 := newFakeIRCServer(t)
	irc2 := newFakeIRCServer(t)

	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	connectParams := func(id, host string, port int) json.RawMessage {
		raw, _ := json.Marshal(ConnectParams{
			ServerID: id, Hostname: host, Port: port, TLS: false, Nick: id + "-bot",
		})
		return raw
	}
	writeJSON(t, c, ClientMessage{Type: CmdConnect, Params: connectParams("srv-a", irc1.addr, irc1.port)})
	writeJSON(t, c, ClientMessage{Type: CmdConnect, Params: connectParams("srv-b", irc2.addr, irc2.port)})

	// Wait for both to be welcomed (i.e. status=connected for each).
	rdr := wrapConn(func(ctx context.Context) (ServerMessage, bool) {
		_, data, err := c.Read(ctx)
		if err != nil {
			return ServerMessage{}, false
		}
		var msg ServerMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			return ServerMessage{}, false
		}
		return msg, true
	})

	seenConnected := map[string]bool{}
	readUntil(t, rdr, func(m ServerMessage) bool {
		if m.Type == MsgStatus && m.State == StateConnected {
			seenConnected[m.ServerID] = true
		}
		return seenConnected["srv-a"] && seenConnected["srv-b"]
	})

	// Privmsg to each, expect echo back tagged with the right serverId.
	pm := func(id, target, body string) json.RawMessage {
		raw, _ := json.Marshal(PrivmsgParams{ServerID: id, Target: target, Message: body})
		return raw
	}
	writeJSON(t, c, ClientMessage{Type: CmdPrivmsg, Params: pm("srv-a", "#room", "ping-a")})
	writeJSON(t, c, ClientMessage{Type: CmdPrivmsg, Params: pm("srv-b", "#room", "ping-b")})

	// Collect PRIVMSG events; assert each one carries the right ServerID.
	gotA, gotB := false, false
	readUntil(t, rdr, func(m ServerMessage) bool {
		if m.Type == MsgEvent && m.Event != nil && m.Event.Kind == "PRIVMSG" {
			if m.Event.Message == "ping-a" && m.ServerID == "srv-a" {
				gotA = true
			}
			if m.Event.Message == "ping-b" && m.ServerID == "srv-b" {
				gotB = true
			}
		}
		return gotA && gotB
	})
	assert.True(t, gotA, "did not observe srv-a echo with its serverId")
	assert.True(t, gotB, "did not observe srv-b echo with its serverId")
}

func TestSession_DisconnectOneLeavesOtherRunning(t *testing.T) {
	irc1 := newFakeIRCServer(t)
	irc2 := newFakeIRCServer(t)

	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	connectParams := func(id, host string, port int) json.RawMessage {
		raw, _ := json.Marshal(ConnectParams{
			ServerID: id, Hostname: host, Port: port, TLS: false, Nick: id + "-bot",
		})
		return raw
	}
	writeJSON(t, c, ClientMessage{Type: CmdConnect, Params: connectParams("srv-a", irc1.addr, irc1.port)})
	writeJSON(t, c, ClientMessage{Type: CmdConnect, Params: connectParams("srv-b", irc2.addr, irc2.port)})

	rdr := wrapConn(func(ctx context.Context) (ServerMessage, bool) {
		_, data, err := c.Read(ctx)
		if err != nil {
			return ServerMessage{}, false
		}
		var msg ServerMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			return ServerMessage{}, false
		}
		return msg, true
	})

	// Wait for both connected.
	connected := map[string]bool{}
	readUntil(t, rdr, func(m ServerMessage) bool {
		if m.Type == MsgStatus && m.State == StateConnected {
			connected[m.ServerID] = true
		}
		return connected["srv-a"] && connected["srv-b"]
	})

	// Disconnect srv-a.
	disconnectParams, _ := json.Marshal(DisconnectParams{ServerID: "srv-a"})
	writeJSON(t, c, ClientMessage{Type: CmdDisconnect, Params: disconnectParams})

	// Wait for status=disconnected for srv-a — and assert srv-b never emits
	// disconnected in the same window.
	disconnectedA := false
	disconnectedB := false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !disconnectedA {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		_, data, err := c.Read(ctx)
		cancel()
		if err != nil {
			continue
		}
		var msg ServerMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg.Type == MsgStatus && msg.State == StateDisconnected {
			if msg.ServerID == "srv-a" {
				disconnectedA = true
			}
			if msg.ServerID == "srv-b" {
				disconnectedB = true
			}
		}
	}
	assert.True(t, disconnectedA, "srv-a should disconnect")
	assert.False(t, disconnectedB, "srv-b should not be affected by srv-a disconnect")

	// srv-b is still alive: send it a PRIVMSG and observe the echo.
	pmB, _ := json.Marshal(PrivmsgParams{ServerID: "srv-b", Target: "#room", Message: "still-here"})
	writeJSON(t, c, ClientMessage{Type: CmdPrivmsg, Params: pmB})

	gotEcho := false
	readUntil(t, rdr, func(m ServerMessage) bool {
		if m.Type == MsgEvent && m.Event != nil && m.Event.Kind == "PRIVMSG" &&
			m.Event.Message == "still-here" && m.ServerID == "srv-b" {
			gotEcho = true
			return true
		}
		return false
	})
	assert.True(t, gotEcho, "srv-b should still relay events after srv-a disconnect")
}

func TestSession_DuplicateConnectForSameServerIDIsRejected(t *testing.T) {
	irc1 := newFakeIRCServer(t)

	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	raw, _ := json.Marshal(ConnectParams{
		ServerID: "srv-x", Hostname: irc1.addr, Port: irc1.port, TLS: false, Nick: "bot",
	})
	writeJSON(t, c, ClientMessage{Type: CmdConnect, Params: raw})
	// Wait for the first connect to be established.
	rdr := wrapConn(func(ctx context.Context) (ServerMessage, bool) {
		_, data, err := c.Read(ctx)
		if err != nil {
			return ServerMessage{}, false
		}
		var msg ServerMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			return ServerMessage{}, false
		}
		return msg, true
	})
	readUntil(t, rdr, func(m ServerMessage) bool {
		return m.Type == MsgStatus && m.State == StateConnected && m.ServerID == "srv-x"
	})

	// Second connect for the same id should produce an error.
	writeJSON(t, c, ClientMessage{Type: CmdConnect, Params: raw})
	sawDup := readUntil(t, rdr, func(m ServerMessage) bool {
		return m.Type == MsgError && m.ServerID == "srv-x"
	})
	assert.NotEmpty(t, sawDup)
}
