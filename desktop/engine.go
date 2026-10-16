package main

import (
	"context"
	"errors"
	"sync"

	"github.com/boson-chat/boson/engine/ipc"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Engine → renderer events. Both carry the session they belong to, so a
// socket never hears a session that isn't its own.
const (
	// EngineEvent carries a protocol frame: engineFrame.
	EngineEvent = "engine:frame"
	// EngineClosedEvent says a session ended (its id), however it ended.
	EngineClosedEvent = "engine:closed"
)

type engineFrame struct {
	Session int    `json:"session"`
	Frame   string `json:"frame"`
}

// EngineService runs the engine in-process and carries its protocol over
// Wails: the renderer sends frames through Send, and receives them as
// EngineEvent events. One session at a time — Open (on every page load)
// replaces the previous one, which quits the IRC connections it owned,
// exactly like a WebSocket reconnect.
type EngineService struct {
	mu   sync.Mutex
	cur  *eventTransport
	stop context.CancelFunc
	seq  int
	// emit sends an event to the renderer; nil means the Wails app's.
	emit func(name string, data any)
}

func (e *EngineService) send(name string, data any) {
	if e.emit != nil {
		e.emit(name, data)
		return
	}
	application.Get().Event.Emit(name, data)
}

// Open starts a session and returns its id, which tags its events.
func (e *EngineService) Open() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stop != nil {
		e.stop()
	}
	e.seq++
	ctx, cancel := context.WithCancel(context.Background())
	t := &eventTransport{id: e.seq, in: make(chan []byte, 256), done: ctx.Done(), abort: make(chan struct{}), emit: e.send}
	e.cur, e.stop = t, cancel
	go func() {
		ipc.ServeSession(ctx, t)
		cancel()
		e.send(EngineClosedEvent, t.id)
	}()
	return t.id
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
	case <-t.abort:
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

// crash ends the current session as an engine crash would: its IRC
// connections drop without a QUIT (ipc.ErrAborted), and the renderer hears
// the session close. Returns the session's id, or 0 when none was open.
// e2e builds only (E2EService.CrashEngine).
func (e *EngineService) crash() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	t := e.cur
	if t == nil {
		return 0
	}
	// Not e.stop(): a cancelled context is a clean close, and would QUIT.
	// The session cancels its own context once it has dropped everything.
	close(t.abort)
	e.cur, e.stop = nil, nil
	return t.id
}

// session is the open session's id (0 when none).
func (e *EngineService) session() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cur == nil {
		return 0
	}
	return e.cur.id
}

func (e *EngineService) ServiceShutdown() error {
	e.Close()
	return nil
}

// eventTransport is an ipc.Transport over Wails: frames in from Send,
// frames out as events.
type eventTransport struct {
	id    int
	in    chan []byte
	done  <-chan struct{}
	abort chan struct{}
	emit  func(name string, data any)
}

func (t *eventTransport) Read(ctx context.Context) ([]byte, error) {
	select {
	case f := <-t.in:
		return f, nil
	case <-t.abort:
		return nil, ipc.ErrAborted
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (t *eventTransport) Write(ctx context.Context, frame []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	t.emit(EngineEvent, engineFrame{Session: t.id, Frame: string(frame)})
	return nil
}
