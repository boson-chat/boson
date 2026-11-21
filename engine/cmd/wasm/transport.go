package main

import (
	"context"
	"errors"
	"sync"
)

var errClosed = errors.New("engine session closed")

// transport is an ipc.Transport over function calls: frames from the
// renderer are pushed in (in order, never blocking the JS caller), frames
// to it go out through write.
type transport struct {
	write func([]byte)

	mu     sync.Mutex
	queue  [][]byte
	kick   chan struct{}
	done   chan struct{}
	closed bool
}

func newTransport(write func([]byte)) *transport {
	return &transport{write: write, kick: make(chan struct{}, 1), done: make(chan struct{})}
}

func (t *transport) push(frame string) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.queue = append(t.queue, []byte(frame))
	t.mu.Unlock()
	select {
	case t.kick <- struct{}{}:
	default:
	}
}

func (t *transport) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.closed {
		t.closed = true
		close(t.done)
	}
}

func (t *transport) Read(ctx context.Context) ([]byte, error) {
	for {
		t.mu.Lock()
		if len(t.queue) > 0 {
			f := t.queue[0]
			t.queue = t.queue[1:]
			t.mu.Unlock()
			return f, nil
		}
		t.mu.Unlock()
		select {
		case <-t.kick:
		case <-t.done:
			return nil, errClosed
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

func (t *transport) Write(_ context.Context, frame []byte) error {
	select {
	case <-t.done:
		return errClosed
	default:
	}
	t.write(frame)
	return nil
}
