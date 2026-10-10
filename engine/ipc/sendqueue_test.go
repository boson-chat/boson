package ipc

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSession_SlowSendOnOneServerDoesNotDelayAnother(t *testing.T) {
	// Sends used to be paced by girc *inside* the IPC dispatch loop, so a
	// backlog on one server (a paste, the post-connect burst) stalled every
	// command for every server on the session. Now commands only enqueue:
	// a long paced backlog on srv-a must not delay a message to srv-b.
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
	connected := map[string]bool{}
	readUntil(t, rdr, func(m ServerMessage) bool {
		if m.Type == MsgStatus && m.State == StateConnected {
			connected[m.ServerID] = true
		}
		return connected["srv-a"] && connected["srv-b"]
	})

	pm := func(id, target, body string) json.RawMessage {
		raw, _ := json.Marshal(PrivmsgParams{ServerID: id, Target: target, Message: body})
		return raw
	}
	// ~30 lines at 1/s after the burst: srv-a's queue stays busy for ~25s.
	for i := 0; i < 30; i++ {
		writeJSON(t, c, ClientMessage{Type: CmdPrivmsg, Params: pm("srv-a", "#room", fmt.Sprintf("flood-%d", i))})
	}
	start := time.Now()
	writeJSON(t, c, ClientMessage{Type: CmdPrivmsg, Params: pm("srv-b", "#room", "urgent")})
	readUntil(t, rdr, func(m ServerMessage) bool {
		return m.Type == MsgEvent && m.ServerID == "srv-b" && m.Event != nil &&
			m.Event.Kind == "PRIVMSG" && m.Event.Message == "urgent"
	})
	elapsed := time.Since(start)
	t.Logf("srv-b echo after srv-a backlog: %s", elapsed)
	require.Less(t, elapsed, time.Second, "srv-b command delayed by srv-a's send backlog")
}
