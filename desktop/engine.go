package main

import (
	"context"
	"errors"
	"sync"

	"github.com/boson-chat/boson/engine/ipc"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// EngineEvent carries engine → renderer protocol frames.
const EngineEvent = "engine:frame"

// EngineService runs the engine in-process and carries its protocol over
// Wails: the renderer sends frames through Send, and receives them as
// EngineEvent events. One session at a time — Open (on every page load)
// replaces the previous one, which quits the IRC connections it owned,
// exactly like a WebSocket reconnect.
type EngineService struct {
	mu   sync.Mutex
	cur  *eventTransport
	stop context.CancelFunc
}

func (e *EngineService) Open() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stop != nil {
		e.stop()
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &eventTransport{in: make(chan []byte, 256), done: ctx.Done()}
	e.cur, e.stop = t, cancel
	go ipc.ServeSession(ctx, t)
}

func (e *EngineService) Send(frame string) error {
	e.mu.Lock()
	t := e.cur
	e.mu.Unlock()
	if t == nil {
		return errors.New("engine: not open")
	}
	select {
	case t.in <- []byte(frame):
		return nil
	case <-t.done:
		return errors.New("engine: closed")
	}
}

func (e *EngineService) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stop != nil {
		e.stop()
		e.stop, e.cur = nil, nil
	}
}

func (e *EngineService) ServiceShutdown() error {
	e.Close()
	return nil
}

// eventTransport is an ipc.Transport over Wails: frames in from Send,
// frames out as events.
type eventTransport struct {
	in   chan []byte
	done <-chan struct{}
}

func (t *eventTransport) Read(ctx context.Context) ([]byte, error) {
	select {
	case f := <-t.in:
		return f, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (t *eventTransport) Write(_ context.Context, frame []byte) error {
	application.Get().Event.Emit(EngineEvent, string(frame))
	return nil
}
