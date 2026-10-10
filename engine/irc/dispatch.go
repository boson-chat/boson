package irc

import (
	"context"
	"sync"
)

// dispatchQueue is the per-client FIFO that carries outbound deliveries
// (renderer events, channel-directory updates, services verdicts) from
// girc's exec loop to a single drainer goroutine.
//
// Why it exists: girc runs foreground handlers in order on its exec loop,
// which is what we need for JOIN → 353 → 366, chathistory playback and
// 322 … 323 to reach the renderer in wire order. But the user callbacks end
// in the IPC session's send(), which can block for up to 5s when the
// websocket writer is backed up — doing that on the exec loop would stall
// girc's PING/PONG handling and drop the connection. So the handler only
// enqueues here (never blocks), and one goroutine per client pops items in
// order and runs them. One drainer ⇒ FIFO order is preserved end to end.
//
// The queue is unbounded: a bounded queue would have to either block the
// exec loop (the thing we're avoiding) or drop events (which desyncs the
// renderer's channel state). Growth is naturally limited by the server's
// own output rate, and send()'s 5s timeout means a wedged renderer still
// makes forward progress rather than accumulating forever.
type dispatchQueue struct {
	mu    sync.Mutex
	items []func()
	// wake is signalled (non-blocking, cap 1) on every push so an idle
	// drainer re-checks the queue. Coalescing is fine: the drainer always
	// empties the queue before waiting again.
	wake chan struct{}
}

func newDispatchQueue() *dispatchQueue {
	return &dispatchQueue{wake: make(chan struct{}, 1)}
}

// push appends fn and nudges the drainer. Never blocks, so it's safe to call
// from girc's exec loop and from timer goroutines alike.
func (q *dispatchQueue) push(fn func()) {
	q.mu.Lock()
	q.items = append(q.items, fn)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// pop removes and returns the oldest item, or nil when the queue is empty.
func (q *dispatchQueue) pop() func() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return nil
	}
	fn := q.items[0]
	q.items[0] = nil // let the closure be collected
	q.items = q.items[1:]
	if len(q.items) == 0 {
		// Drop the backing array so a one-off burst (e.g. a 50k-line LIST
		// on a big network) doesn't pin its peak capacity forever.
		q.items = nil
	}
	return fn
}

// reset discards everything still queued. Used when the connection context
// is cancelled: the renderer has already been told we're disconnected, so
// stale events for this server would only confuse it.
func (q *dispatchQueue) reset() {
	q.mu.Lock()
	q.items = nil
	q.mu.Unlock()
}

// run drains the queue in FIFO order until told to stop. Exit conditions:
//
//   - ctx cancelled (user disconnect / session teardown): drop whatever is
//     still queued and return promptly.
//   - stop closed (girc has fully exited, so nothing more will arrive from
//     the exec loop): deliver what's left — a trailing ERROR or 4xx is
//     exactly the reason the renderer should show — then return.
//
// An in-flight callback is never interrupted; the IPC send() it ends in is
// itself bounded (5s / session ctx), so exit is bounded too.
func (q *dispatchQueue) run(ctx context.Context, stop <-chan struct{}) {
	for {
		if ctx.Err() != nil {
			q.reset()
			return
		}
		if fn := q.pop(); fn != nil {
			fn()
			continue
		}
		select {
		case <-q.wake:
		case <-ctx.Done():
		case <-stop:
			for fn := q.pop(); fn != nil && ctx.Err() == nil; fn = q.pop() {
				fn()
			}
			q.reset()
			return
		}
	}
}

// startDispatch launches the drainer for one connection lifetime and returns
// a stop func that signals it and blocks until the goroutine has exited, so
// Connect never returns with a drainer still running (no goroutine leak).
func (c *Client) startDispatch(ctx context.Context) (stop func()) {
	stopCh := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.dispatch.run(ctx, stopCh)
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(stopCh) })
		<-done
	}
}
