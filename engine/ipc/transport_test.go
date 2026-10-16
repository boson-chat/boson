package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// chanTransport is an in-memory Transport, the shape a non-WebSocket
// carrier (e.g. a desktop shell's bindings and events) plugs in as.
type chanTransport struct {
	in  chan []byte
	out chan []byte
}

var errClosed = errors.New("closed")

func (c *chanTransport) Read(ctx context.Context) ([]byte, error) {
	select {
	case f, ok := <-c.in:
		if !ok {
			return nil, errClosed
		}
		return f, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *chanTransport) Write(_ context.Context, frame []byte) error {
	c.out <- frame
	return nil
}

func TestServeSessionOverCustomTransport(t *testing.T) {
	tr := &chanTransport{in: make(chan []byte, 4), out: make(chan []byte, 4)}
	done := make(chan struct{})
	go func() {
		ServeSession(context.Background(), tr)
		close(done)
	}()

	next := func() ServerMessage {
		t.Helper()
		select {
		case f := <-tr.out:
			var m ServerMessage
			if err := json.Unmarshal(f, &m); err != nil {
				t.Fatalf("bad frame %q: %v", f, err)
			}
			return m
		case <-time.After(2 * time.Second):
			t.Fatal("no frame from session")
		}
		return ServerMessage{}
	}

	tr.in <- []byte("{not json")
	if m := next(); m.Type != MsgError {
		t.Fatalf("bad json: got %+v, want an error", m)
	}
	tr.in <- []byte(`{"type":"connect","params":{}}`)
	if m := next(); m.Type != MsgError || m.Error != "connect: serverId is required" {
		t.Fatalf("connect without serverId: got %+v", m)
	}

	// Closing the transport ends the session.
	close(tr.in)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ServeSession did not return after the transport closed")
	}
}

// abortTransport ends with ErrAborted (a simulated crash) or a plain error (a
// clean close) once end is closed.
type abortTransport struct {
	chanTransport
	end   chan struct{}
	crash bool
}

func (a *abortTransport) Read(ctx context.Context) ([]byte, error) {
	select {
	case f := <-a.in:
		return f, nil
	case <-a.end:
		if a.crash {
			return nil, ErrAborted
		}
		return nil, errClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// lineRecorder accepts one IRC connection, welcomes it, and reports every
// line it got once the client hangs up.
func lineRecorder(t *testing.T) (port int, welcomed <-chan struct{}, lines <-chan []string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	w := make(chan struct{})
	out := make(chan []string, 1)
	go func() {
		conn, err := l.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var got []string
		rd := bufio.NewReader(conn)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			line, err := rd.ReadString('\n')
			if err != nil {
				out <- got
				return
			}
			line = strings.TrimRight(line, "\r\n")
			got = append(got, line)
			if strings.HasPrefix(line, "USER ") {
				_, _ = fmt.Fprintf(conn, ":fake.irc 001 bot :Welcome\r\n")
				close(w)
			}
		}
	}()
	return l.Addr().(*net.TCPAddr).Port, w, out
}

func TestServeSession_AbortDropsIRCWithoutQuit(t *testing.T) {
	for _, crash := range []bool{true, false} {
		port, welcomed, lines := lineRecorder(t)
		tr := &abortTransport{
			chanTransport: chanTransport{in: make(chan []byte, 4), out: make(chan []byte, 64)},
			end:           make(chan struct{}),
			crash:         crash,
		}
		go ServeSession(context.Background(), tr)
		params, _ := json.Marshal(ConnectParams{ServerID: "s", Hostname: "127.0.0.1", Port: port, Nick: "bot"})
		raw, _ := json.Marshal(ClientMessage{Type: CmdConnect, Params: params})
		tr.in <- raw
		select {
		case <-welcomed:
		case <-time.After(5 * time.Second):
			t.Fatal("never registered")
		}
		close(tr.end)
		var got []string
		select {
		case got = <-lines:
		case <-time.After(10 * time.Second):
			t.Fatalf("crash=%v: the IRC connection was not closed", crash)
		}
		quit := false
		for _, l := range got {
			quit = quit || strings.HasPrefix(l, "QUIT")
		}
		if quit == crash {
			t.Fatalf("crash=%v: QUIT sent = %v, lines %q", crash, quit, got)
		}
	}
}
