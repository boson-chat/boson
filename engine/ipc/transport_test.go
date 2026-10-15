package ipc

import (
	"context"
	"encoding/json"
	"errors"
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
