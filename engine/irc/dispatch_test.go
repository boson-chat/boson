package irc

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"math/rand"
	"net"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lrstanley/girc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// recorder collects callback deliveries from the dispatch drainer. The
// drainer is a different goroutine from the test, so everything is locked.
type recorder struct {
	mu        sync.Mutex
	events    []Event
	dirs      [][]ChannelDirectoryEntry
	dirBefore []int // len(events) at the moment each directory update landed
}

func (r *recorder) onEvent(e Event) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *recorder) onDir(entries []ChannelDirectoryEntry) {
	r.mu.Lock()
	r.dirs = append(r.dirs, entries)
	r.dirBefore = append(r.dirBefore, len(r.events))
	r.mu.Unlock()
}

func (r *recorder) eventCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.events)
}

func (r *recorder) snapshot() ([]Event, [][]ChannelDirectoryEntry, []int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Event(nil), r.events...),
		append([][]ChannelDirectoryEntry(nil), r.dirs...),
		append([]int(nil), r.dirBefore...)
}

func TestOnEvent_DeliversInWireOrderWithSlowCallback(t *testing.T) {
	// The old AddBg handler ran each event on its own goroutine, so a slow
	// callback (the IPC send under backpressure) let later events overtake
	// earlier ones. Feed events through girc's real handler pipeline with a
	// jittery, slow callback and require exact wire order on the other side.
	c := newTestClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := c.startDispatch(ctx)
	defer stop()

	const n = 100
	const delay = 2 * time.Millisecond
	rng := rand.New(rand.NewSource(1))
	var rngMu sync.Mutex
	rec := &recorder{}
	// gate holds the very first callback until every event has been fed:
	// a fully wedged renderer must not stall the handler (girc's exec loop,
	// and with it PING handling). After release, a jittery delay keeps the
	// consumer slow so any reordering would show up.
	gate := make(chan struct{})
	var first sync.Once
	c.OnEvent(func(e Event) {
		first.Do(func() { <-gate })
		rngMu.Lock()
		d := time.Duration(rng.Int63n(int64(delay)))
		rngMu.Unlock()
		time.Sleep(d)
		rec.onEvent(e)
	})

	fed := make(chan struct{})
	go func() {
		defer close(fed)
		for i := 0; i < n; i++ {
			// RunHandlers is what girc's exec loop calls per inbound line.
			c.girc.RunHandlers(&girc.Event{
				Command: girc.PRIVMSG,
				Source:  &girc.Source{Name: "bob"},
				Params:  []string{"#chan", strconv.Itoa(i)},
			})
		}
	}()
	select {
	case <-fed:
	case <-time.After(5 * time.Second):
		close(gate)
		t.Fatal("handler blocked on the wedged callback")
	}
	close(gate)

	require.Eventually(t, func() bool { return rec.eventCount() == n },
		5*time.Second, 5*time.Millisecond)
	events, _, _ := rec.snapshot()
	for i, e := range events {
		require.Equal(t, strconv.Itoa(i), e.Message, "event %d delivered out of order", i)
	}
}

func TestOnEvent_ListCollectedNotForwarded(t *testing.T) {
	// 322s must be swallowed (no per-line frames to the renderer) and the
	// 323 flush must see every preceding 322 — under the old concurrent
	// handlers the flush could run before the last collect and ship an
	// incomplete directory.
	c := newTestClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := c.startDispatch(ctx)
	defer stop()

	rec := &recorder{}
	c.OnEvent(rec.onEvent)
	c.OnChannelDirectory(rec.onDir)

	const n = 500
	src := &girc.Source{Name: "irc.example.com"}
	c.girc.RunHandlers(&girc.Event{Command: girc.RPL_LISTSTART, Source: src,
		Params: []string{"tester", "Channel", "Users  Name"}})
	for i := 0; i < n; i++ {
		c.girc.RunHandlers(&girc.Event{Command: girc.RPL_LIST, Source: src,
			Params: []string{"tester", fmt.Sprintf("#c%d", i), strconv.Itoa(i), "topic"}})
	}
	c.girc.RunHandlers(&girc.Event{Command: girc.RPL_LISTEND, Source: src,
		Params: []string{"tester", "End of /LIST"}})

	require.Eventually(t, func() bool {
		_, dirs, _ := rec.snapshot()
		return len(dirs) == 1 && rec.eventCount() == 2
	}, 5*time.Second, 5*time.Millisecond)

	events, dirs, dirBefore := rec.snapshot()
	kinds := make([]string, len(events))
	for i, e := range events {
		kinds[i] = e.Kind
	}
	// 321 and 323 still flow through the generic numeric path; 322 never does.
	assert.Equal(t, []string{girc.RPL_LISTSTART, girc.RPL_LISTEND}, kinds)

	require.Len(t, dirs[0], n, "directory update missing entries")
	for i, entry := range dirs[0] {
		assert.Equal(t, fmt.Sprintf("#c%d", i), entry.Name)
		assert.Equal(t, i, entry.UserCount)
		assert.Equal(t, "topic", entry.Topic)
	}
	// The directory update is queued ahead of the 323 event itself, so it
	// lands after 321 and before 323.
	assert.Equal(t, []int{1}, dirBefore)
}

func TestDispatchQueue_StopDeliversTailThenExits(t *testing.T) {
	// When girc exits on its own (transport error), queued items — e.g. the
	// ERROR line explaining why — are still delivered before stop returns.
	c := newTestClient(t)
	var mu sync.Mutex
	var got []int
	for i := 0; i < 10; i++ {
		i := i
		c.dispatch.push(func() {
			mu.Lock()
			got = append(got, i)
			mu.Unlock()
		})
	}
	stop := c.startDispatch(context.Background())
	stop() // blocks until the drainer goroutine has exited

	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}, got)
}

func TestDispatchQueue_CancelDropsTailAndExits(t *testing.T) {
	// On ctx cancellation (user disconnect / session teardown) the drainer
	// drops what's queued and exits even though stop was never signalled.
	c := newTestClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	stopCh := make(chan struct{})
	done := make(chan struct{})

	release := make(chan struct{})
	var ran sync.WaitGroup
	ran.Add(1)
	c.dispatch.push(func() { ran.Done(); <-release })
	var late bool
	c.dispatch.push(func() { late = true })

	go func() {
		defer close(done)
		c.dispatch.run(ctx, stopCh)
	}()
	ran.Wait() // first item is in flight
	cancel()
	close(release)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("drainer did not exit after ctx cancellation")
	}
	assert.False(t, late, "queued item ran after cancellation")
	assert.Nil(t, c.dispatch.pop(), "queue not reset on cancellation")
}

// fakeIRCServer accepts one connection, writes the given lines, and swallows
// whatever the client sends. Enough to drive girc through registration and a
// handful of events over a real socket.
func fakeIRCServer(t *testing.T, lines []string) (port int, closeFn func()) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	var wg sync.WaitGroup
	var connMu sync.Mutex
	var conn net.Conn
	wg.Add(1)
	go func() {
		defer wg.Done()
		cn, err := l.Accept()
		if err != nil {
			return
		}
		connMu.Lock()
		conn = cn
		connMu.Unlock()
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = io.Copy(io.Discard, cn) }()
		w := bufio.NewWriter(cn)
		for _, line := range lines {
			_, _ = w.WriteString(line + "\r\n")
		}
		_ = w.Flush()
	}()
	return l.Addr().(*net.TCPAddr).Port, func() {
		_ = l.Close()
		connMu.Lock()
		if conn != nil {
			_ = conn.Close()
		}
		connMu.Unlock()
		wg.Wait()
	}
}

// userGoroutines counts goroutines visible in a full stack dump.
// runtime.NumGoroutine also counts runtime-internal goroutines that start
// lazily (e.g. the first time the network poller or cleanup queue is used),
// which would make a before/after comparison around a socket test flaky.
func userGoroutines() int {
	buf := make([]byte, 1<<20)
	return strings.Count(string(buf[:runtime.Stack(buf, true)]), "\ngoroutine ") + 1
}

func TestConnect_OrderedDeliveryAndNoGoroutineLeak(t *testing.T) {
	// End to end over a socket: wire-order delivery through Connect's
	// drainer, and once Connect returns (ctx cancelled) every goroutine it
	// started — girc's loops and our drainer — is gone.
	baseline := userGoroutines()

	lines := []string{":srv 001 tester :Welcome"}
	for i := 0; i < 50; i++ {
		lines = append(lines, fmt.Sprintf(":bob!b@h PRIVMSG #chan :%d", i))
	}
	port, closeSrv := fakeIRCServer(t, lines)

	c, err := New(Config{Hostname: "127.0.0.1", Port: port, Nick: "tester"})
	require.NoError(t, err)
	rec := &recorder{}
	c.OnEvent(func(e Event) {
		if e.Kind == girc.PRIVMSG {
			time.Sleep(time.Millisecond) // slow consumer
			rec.onEvent(e)
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	connDone := make(chan error, 1)
	go func() { connDone <- c.Connect(ctx) }()

	require.Eventually(t, func() bool { return rec.eventCount() == 50 },
		5*time.Second, 5*time.Millisecond)
	events, _, _ := rec.snapshot()
	for i, e := range events {
		require.Equal(t, strconv.Itoa(i), e.Message)
	}

	cancel()
	select {
	case err := <-connDone:
		assert.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("Connect did not return after ctx cancellation")
	}
	closeSrv()

	// girc's own background handlers (e.g. its post-welcome 2s sleep before
	// CONNECTED) wind down asynchronously; poll rather than asserting an
	// instantaneous count. Polled inline — not via assert.Eventually, whose
	// condition goroutine would itself inflate the count.
	deadline := time.Now().Add(5 * time.Second)
	for userGoroutines() > baseline && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := userGoroutines(); n > baseline {
		buf := make([]byte, 1<<20)
		t.Fatalf("goroutines leaked: %d > baseline %d\n%s",
			n, baseline, buf[:runtime.Stack(buf, true)])
	}
}
