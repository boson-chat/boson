package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newFakeZNC starts a minimal ZNC impersonation on loopback. It attaches the
// client with the upstream disconnected (ZNC 1.9.1's real burst: synthetic
// 001 from irc.znc.in + a *status line), answers `connect` with the live
// upstream burst and `disconnect` with the status confirmation — the
// sequences recorded in the ZNC lab report.
func newFakeZNC(t *testing.T) (host string, port int) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go serveFakeZNC(conn)
		}
	}()
	return "127.0.0.1", l.Addr().(*net.TCPAddr).Port
}

func serveFakeZNC(conn net.Conn) {
	defer conn.Close()
	rd := bufio.NewReader(conn)
	nick := "anon"
	say := func(lines ...string) {
		for _, l := range lines {
			_, _ = fmt.Fprintf(conn, "%s\r\n", l)
		}
	}
	status := func(body string) { say(":*status!status@znc.in PRIVMSG " + nick + " :" + body) }
	for {
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case strings.HasPrefix(line, "NICK "):
			nick = strings.TrimSpace(strings.TrimPrefix(line, "NICK "))
		case strings.HasPrefix(line, "USER "):
			say(":irc.znc.in 001 " + nick + " :Welcome to ZNC")
			status("You are currently disconnected from IRC. Use 'connect' to reconnect.")
		case strings.HasPrefix(line, "PING "):
			say("PONG " + strings.TrimPrefix(line, "PING "))
		case strings.HasPrefix(line, "PRIVMSG *status "):
			switch strings.TrimPrefix(strings.TrimPrefix(line, "PRIVMSG *status "), ":") {
			case "connect":
				status("Connecting to ergo...")
				status("Connected!")
				say(":ergo.test 001 "+nick+" :Welcome to the BosonTest IRC Network "+nick,
					":ergo.test 005 "+nick+" NETWORK=BosonTest :are supported by this server",
					":ergo.test 422 "+nick+" :MOTD File is missing")
			case "disconnect":
				status("Disconnected from IRC. Use 'connect' to reconnect.")
			}
		case strings.HasPrefix(line, "QUIT"):
			return
		}
	}
}

// readUpstream reads frames until the next bouncer-upstream message.
func readUpstream(t *testing.T, rdr readJSONer) ServerMessage {
	t.Helper()
	got := readUntil(t, rdr, func(m ServerMessage) bool { return m.Type == MsgBouncerUpstream })
	return got[len(got)-1]
}

func TestSession_BouncerUpstreamOverWebsocket(t *testing.T) {
	cases := []struct {
		name        string
		autoConnect bool
	}{
		{"manual bouncer-connect", false},
		{"bouncerAutoConnect", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			host, port := newFakeZNC(t)
			srv, wsURL := newTestServer(t)
			c := dial(t, wsURL, srv.Token())
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

			// Raw JSON so the wire field names are what's under test.
			writeJSON(t, c, ClientMessage{Type: CmdConnect, Params: json.RawMessage(fmt.Sprintf(
				`{"serverId":"znc","hostname":%q,"port":%d,"nick":"tester","bouncer":true,"bouncerAutoConnect":%t}`,
				host, port, tc.autoConnect))})

			// The attach report arrives after the synthetic 001's
			// status=connected, so a renderer resetting per-server state on
			// "connected" can't wipe it.
			frames := readUntil(t, rdr, func(m ServerMessage) bool { return m.Type == MsgBouncerUpstream })
			sawStatus := false
			for _, f := range frames {
				if f.Type == MsgStatus && f.State == StateConnected {
					sawStatus = true
				}
			}
			assert.True(t, sawStatus, "bouncer-upstream overtook status=connected")
			m := frames[len(frames)-1]
			assert.Equal(t, "znc", m.ServerID)
			assert.Equal(t, "disconnected", m.Upstream)

			if !tc.autoConnect {
				writeJSON(t, c, ClientMessage{Type: "bouncer-connect", Params: json.RawMessage(`{"serverId":"znc"}`)})
			}
			assert.Equal(t, "connecting", readUpstream(t, rdr).Upstream)
			// The upstream burst's 422 ERR_NOMOTD is informational: forwarded
			// as an event, never as a session error. "connected" is emitted on
			// the 001, so the 422 may still be in flight behind it — wait for
			// it before disconnecting rather than racing the exec loop.
			saw422 := false
			var all []ServerMessage
			is422 := func(f ServerMessage) bool {
				return f.Type == MsgEvent && f.Event != nil && f.Event.Kind == "422"
			}
			frames = readUntil(t, rdr, func(m ServerMessage) bool { return m.Type == MsgBouncerUpstream })
			all = append(all, frames...)
			assert.Equal(t, "connected", frames[len(frames)-1].Upstream)
			for _, f := range frames {
				saw422 = saw422 || is422(f)
			}
			if !saw422 {
				all = append(all, readUntil(t, rdr, is422)...)
			}

			writeJSON(t, c, ClientMessage{Type: "bouncer-disconnect", Params: json.RawMessage(`{"serverId":"znc"}`)})
			frames = readUntil(t, rdr, func(m ServerMessage) bool { return m.Type == MsgBouncerUpstream })
			all = append(all, frames...)
			m = frames[len(frames)-1]
			assert.Equal(t, "znc", m.ServerID)
			assert.Equal(t, "disconnected", m.Upstream)
			for _, f := range all {
				assert.NotEqual(t, MsgError, f.Type, "unexpected error frame: %s", f.Error)
			}
		})
	}
}

func TestSession_BouncerCommandsBadParams(t *testing.T) {
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())
	for _, typ := range []string{CmdBouncerConnect, CmdBouncerDisconnect} {
		writeJSON(t, c, ClientMessage{Type: typ, Params: json.RawMessage(`"nope"`)})
		msg := readJSON(t, c)
		assert.Equal(t, MsgError, msg.Type)
		assert.Contains(t, msg.Error, "bad "+typ+" params")
	}
}

func TestSession_PlainServerEmitsNoBouncerUpstream(t *testing.T) {
	irc1 := newFakeIRCServer(t)
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())
	raw, _ := json.Marshal(ConnectParams{ServerID: "plain", Hostname: irc1.addr, Port: irc1.port, Nick: "bot"})
	writeJSON(t, c, ClientMessage{Type: CmdConnect, Params: raw})

	// Read through the welcome and then an echoed PRIVMSG (queued behind
	// anything the 001 could have produced): no bouncer-upstream may appear.
	// Timeout-free on purpose — a cancelled websocket Read closes the conn.
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
	check := func(m ServerMessage) {
		require.NotEqual(t, MsgBouncerUpstream, m.Type, "plain server reported bouncer state")
	}
	for _, m := range readUntil(t, rdr, func(m ServerMessage) bool {
		return m.Type == MsgStatus && m.State == StateConnected
	}) {
		check(m)
	}
	pm, _ := json.Marshal(PrivmsgParams{ServerID: "plain", Target: "#room", Message: "marker"})
	writeJSON(t, c, ClientMessage{Type: CmdPrivmsg, Params: pm})
	for _, m := range readUntil(t, rdr, func(m ServerMessage) bool {
		return m.Type == MsgEvent && m.Event != nil && m.Event.Message == "marker"
	}) {
		check(m)
	}
}
