package irc

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/lrstanley/girc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeClock is a manually advanced clock for the send queue.
type fakeClock struct {
	mu     sync.Mutex
	t      time.Time
	timers []fakeTimer
	nextID int
}

type fakeTimer struct {
	at time.Time
	ch chan time.Time
	id int
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Unix(1_700_000_000, 0)} }

func (f *fakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *fakeClock) NewTimer(d time.Duration) (<-chan time.Time, func() bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch := make(chan time.Time, 1)
	f.nextID++
	id := f.nextID
	f.timers = append(f.timers, fakeTimer{at: f.t.Add(d), ch: ch, id: id})
	return ch, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		for i, tm := range f.timers {
			if tm.id == id {
				f.timers = append(f.timers[:i], f.timers[i+1:]...)
				return true
			}
		}
		return false
	}
}

func (f *fakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
	keep := f.timers[:0]
	for _, tm := range f.timers {
		if !tm.at.After(f.t) {
			tm.ch <- f.t
		} else {
			keep = append(keep, tm)
		}
	}
	f.timers = keep
}

func (f *fakeClock) pending() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.timers)
}

func newTestQueue(p pacing) (*sendQueue, *fakeClock) {
	clk := newFakeClock()
	q := newSendQueue(func() pacing { return p })
	q.now = clk.Now
	q.newTimer = clk.NewTimer
	q.begin()
	return q, clk
}

func pm(target, body string) *girc.Event {
	return &girc.Event{Command: girc.PRIVMSG, Params: []string{target, body}}
}

func typing(target, state string) *girc.Event {
	return &girc.Event{Command: "TAGMSG", Params: []string{target}, Tags: girc.Tags{"+typing": state}}
}

// drain pops everything sendable right now (no clock movement).
func drain(q *sendQueue) []string {
	var out []string
	for {
		ev, _ := q.next()
		if ev == nil {
			return out
		}
		out = append(out, ev.String())
	}
}

func TestSendQueue_InteractiveJumpsQueuedBackground(t *testing.T) {
	q, _ := newTestQueue(directPacing)
	for i := 0; i < 10; i++ {
		q.enqueue(&girc.Event{Command: girc.WHO, Params: []string{fmt.Sprintf("#c%d", i)}}, classBackground, "")
	}
	// Background may spend the bucket only down to the interactive reserve:
	// 6 tokens → 4 WHOs sent, 2 tokens left for the user.
	got := drain(q)
	require.Len(t, got, 4)
	ev, wait := q.next()
	require.Nil(t, ev)
	assert.Greater(t, wait, time.Duration(0), "background should wait for a refill")

	q.enqueue(pm("#chan", "hello"), classInteractive, "")
	ev, _ = q.next()
	require.NotNil(t, ev, "user line must not wait behind background")
	assert.Equal(t, "PRIVMSG #chan hello", ev.String())
}

func TestSendQueue_PriorityOrderWhenAllQueued(t *testing.T) {
	q, _ := newTestQueue(pacing{burst: 100, rate: 1})
	q.enqueue(typing("#a", "active"), classDroppable, typingKey("#a"))
	q.enqueue(&girc.Event{Command: girc.LIST}, classBackground, "")
	q.enqueue(pm("#b", "one"), classInteractive, "")
	q.enqueue(&girc.Event{Command: girc.NAMES, Params: []string{"#b"}}, classBackground, "")
	q.enqueue(pm("#b", "two"), classInteractive, "")
	assert.Equal(t, []string{
		"PRIVMSG #b one", "PRIVMSG #b two", "LIST", "NAMES #b", "@+typing=active TAGMSG #a",
	}, drain(q))
}

func TestSendQueue_FIFOWithinClass(t *testing.T) {
	q, _ := newTestQueue(pacing{}) // unlimited
	var want []string
	for i := 0; i < 50; i++ {
		target := []string{"#a", "#b", "alice"}[i%3]
		q.enqueue(pm(target, fmt.Sprintf("m%d", i)), classInteractive, "")
		want = append(want, fmt.Sprintf("PRIVMSG %s m%d", target, i))
	}
	assert.Equal(t, want, drain(q))
}

func TestSendQueue_TypingCoalescedPerTarget(t *testing.T) {
	q, _ := newTestQueue(directPacing)
	q.enqueue(typing("#a", "active"), classDroppable, typingKey("#a"))
	q.enqueue(typing("#b", "active"), classDroppable, typingKey("#b"))
	q.enqueue(typing("#A", "paused"), classDroppable, typingKey("#A")) // RFC1459 case-folded
	q.enqueue(typing("#a", "done"), classDroppable, typingKey("#a"))
	assert.Equal(t, []string{"@+typing=done TAGMSG #a", "@+typing=active TAGMSG #b"}, drain(q))
}

func TestSendQueue_MessageSupersedesQueuedTyping(t *testing.T) {
	q, _ := newTestQueue(directPacing)
	q.enqueue(typing("#a", "active"), classDroppable, typingKey("#a"))
	q.enqueue(typing("#b", "active"), classDroppable, typingKey("#b"))
	q.enqueue(typing("#c", "done"), classDroppable, typingKey("#c"))
	q.enqueue(pm("#a", "hi"), classInteractive, "")
	q.enqueue(pm("#c", "yo"), classInteractive, "")
	// #a's stale "active" is gone; #b untouched; #c's "done" is harmless
	// after the message and kept.
	assert.Equal(t, []string{"PRIVMSG #a hi", "PRIVMSG #c yo",
		"@+typing=active TAGMSG #b", "@+typing=done TAGMSG #c"}, drain(q))
}

func TestSendQueue_TypingWaitsWhenTokensLow(t *testing.T) {
	q, clk := newTestQueue(directPacing)
	q.charge(directPacing.burst - 1.5) // 1.5 tokens left: below droppableMinTokens
	q.enqueue(typing("#a", "active"), classDroppable, typingKey("#a"))
	ev, wait := q.next()
	assert.Nil(t, ev)
	assert.Positive(t, wait, "held until there's headroom, not dropped")

	// Once the bucket refills past the threshold it goes out (regression:
	// it used to be dropped, losing "typing…" right after every join).
	clk.Advance(wait)
	assert.Equal(t, []string{"@+typing=active TAGMSG #a"}, drain(q))

	// Typing never delays a real line: a message enqueued while typing is
	// held goes first (and supersedes that target's queued "active").
	clk.Advance(10 * time.Second) // refill to a full bucket
	q.charge(q.available() - 1.5)
	q.enqueue(typing("#b", "active"), classDroppable, typingKey("#b"))
	q.enqueue(pm("#a", "x"), classInteractive, "")
	ev, _ = q.next()
	assert.Equal(t, "PRIVMSG #a x", ev.String())

	// With exactly the threshold left, typing goes and a token remains.
	// (2s: enough refill, still well inside droppableTTL for #b.)
	clk.Advance(2 * time.Second)
	q.charge(q.available() - droppableMinTokens)
	assert.Len(t, drain(q), 1)
	q.enqueue(pm("#a", "y"), classInteractive, "")
	assert.Equal(t, []string{"PRIVMSG #a y"}, drain(q))
}

func TestSendQueue_StaleTypingDiscarded(t *testing.T) {
	q, clk := newTestQueue(directPacing)
	q.charge(directPacing.burst) // empty bucket: typing must wait
	q.enqueue(typing("#a", "active"), classDroppable, typingKey("#a"))
	clk.Advance(droppableTTL + time.Second)
	// Plenty of tokens again, but the state is stale: discarded, not sent.
	assert.Empty(t, drain(q))

	// Coalescing refreshes the timestamp: a newer state isn't stale.
	q.charge(directPacing.burst)
	q.enqueue(typing("#a", "active"), classDroppable, typingKey("#a"))
	clk.Advance(droppableTTL - time.Second)
	q.enqueue(typing("#a", "paused"), classDroppable, typingKey("#a"))
	clk.Advance(3 * time.Second) // refill; the paused state is only 3s old
	assert.Equal(t, []string{"@+typing=paused TAGMSG #a"}, drain(q))
}

func TestSendQueue_TokenBucketBurstAndRefill(t *testing.T) {
	q, clk := newTestQueue(directPacing)
	for i := 0; i < 20; i++ {
		q.enqueue(pm("#a", fmt.Sprintf("%d", i)), classInteractive, "")
	}
	assert.Len(t, drain(q), 6, "burst")
	ev, wait := q.next()
	assert.Nil(t, ev)
	assert.Equal(t, time.Second, wait)

	clk.Advance(500 * time.Millisecond)
	ev, wait = q.next()
	assert.Nil(t, ev)
	assert.Equal(t, 500*time.Millisecond, wait)

	clk.Advance(500 * time.Millisecond)
	assert.Len(t, drain(q), 1, "1 line per second sustained")

	clk.Advance(3 * time.Second)
	assert.Len(t, drain(q), 3)

	// Idle refills to the burst cap, never beyond.
	clk.Advance(time.Hour)
	assert.Equal(t, directPacing.burst, q.available())
}

func TestSendQueue_ChargeForSplitAndInternalLines(t *testing.T) {
	q, clk := newTestQueue(directPacing)
	q.charge(4)
	assert.InDelta(t, 2, q.available(), 1e-9)
	// Debt is floored at -burst so it can't starve the queue indefinitely.
	q.charge(1000)
	assert.InDelta(t, -directPacing.burst, q.available(), 1e-9)
	clk.Advance(time.Duration(directPacing.burst+1) * time.Second)
	assert.InDelta(t, 1, q.available(), 1e-9)
}

func TestSendQueue_PacingSwitchesAtRuntime(t *testing.T) {
	// A bouncer detected mid-connection (ZNC's 001) switches profile without
	// restarting the drainer.
	var mu sync.Mutex
	p := directPacing
	clk := newFakeClock()
	q := newSendQueue(func() pacing { mu.Lock(); defer mu.Unlock(); return p })
	q.now = clk.Now
	q.newTimer = clk.NewTimer
	q.begin()
	for i := 0; i < 40; i++ {
		q.enqueue(pm("#a", fmt.Sprintf("%d", i)), classInteractive, "")
	}
	assert.Len(t, drain(q), 6)
	mu.Lock()
	p = bouncerPacing
	mu.Unlock()
	clk.Advance(10 * time.Second) // 0.5 lines/s
	assert.Len(t, drain(q), 5)
}

func TestSendQueue_InactiveDropsEnqueue(t *testing.T) {
	q, _ := newTestQueue(directPacing)
	q.end()
	q.enqueue(pm("#a", "lost"), classInteractive, "")
	q.begin()
	assert.Empty(t, drain(q), "a new connection starts with a fresh queue")
}

func TestSendQueue_RunPacesAndPreservesOrder(t *testing.T) {
	q := newSendQueue(func() pacing { return pacing{burst: 2, rate: 50} })
	q.begin()
	var mu sync.Mutex
	var got []string
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		q.run(ctx, stop, func(ev *girc.Event) int {
			mu.Lock()
			got = append(got, ev.Params[1])
			mu.Unlock()
			return 0
		})
	}()
	start := time.Now()
	for i := 0; i < 12; i++ {
		q.enqueue(pm("#a", fmt.Sprintf("%d", i)), classInteractive, "")
	}
	require.Eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 12 },
		5*time.Second, time.Millisecond)
	// 2 burst + 10 at 50/s ⇒ ~200ms.
	assert.GreaterOrEqual(t, time.Since(start), 150*time.Millisecond)
	for i, s := range got {
		assert.Equal(t, fmt.Sprintf("%d", i), s)
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("drainer did not exit on stop")
	}
}

func TestSendQueue_RunWaitsOnClockThenSends(t *testing.T) {
	q, clk := newTestQueue(pacing{burst: 1, rate: 1})
	sent := make(chan string, 10)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		q.run(ctx, nil, func(ev *girc.Event) int { sent <- ev.Params[1]; return 0 })
	}()
	q.enqueue(pm("#a", "a"), classInteractive, "")
	q.enqueue(pm("#a", "b"), classInteractive, "")
	assert.Equal(t, "a", <-sent)
	require.Eventually(t, func() bool { return clk.pending() == 1 }, time.Second, time.Millisecond)
	select {
	case s := <-sent:
		t.Fatalf("sent %q before the bucket refilled", s)
	case <-time.After(20 * time.Millisecond):
	}
	clk.Advance(time.Second)
	assert.Equal(t, "b", <-sent)
	cancel()
	<-done
}

func TestSendQueue_EnqueueNeverBlocksWithStuckWriter(t *testing.T) {
	q := newSendQueue(func() pacing { return pacing{} })
	q.begin()
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		q.run(ctx, nil, func(*girc.Event) int {
			select {
			case entered <- struct{}{}:
			default:
			}
			<-release // a wedged socket
			return 0
		})
	}()
	q.enqueue(pm("#a", "first"), classInteractive, "")
	<-entered

	start := time.Now()
	for i := 0; i < 10000; i++ {
		q.enqueue(pm("#a", "x"), classInteractive, "")
		q.enqueue(typing("#a", "active"), classDroppable, typingKey("#a"))
	}
	assert.Less(t, time.Since(start), 500*time.Millisecond, "enqueue blocked on a stuck writer")

	// Disconnect while the writer is stuck: the drainer exits as soon as
	// the in-flight write returns, dropping the backlog.
	cancel()
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("drainer leaked after cancellation")
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	assert.False(t, q.active)
	for _, cl := range q.queues {
		assert.Empty(t, cl, "backlog for a dead connection must be dropped")
	}
}

func TestClient_SendClasses(t *testing.T) {
	// Every engine-originated send lands in the right class.
	c := newTestClient(t)
	c.sendq.begin()
	c.Privmsg("#a", "hi")
	c.Join("#b")
	c.Part("#b")
	c.Nick("newnick")
	c.Away("brb")
	c.SendRaw("MODE #a +o bob")
	c.NickservIdentify("pw")
	c.BouncerDisconnect()
	c.Names("#a")
	c.List()
	c.Tagmsg("#a", map[string]string{"+typing": "active"})
	c.Tagmsg("#a", map[string]string{"+draft/react": "👍", "+draft/reply": "x"})

	c.sendq.mu.Lock()
	defer c.sendq.mu.Unlock()
	lines := func(cl sendClass) []string {
		var out []string
		for _, o := range c.sendq.queues[cl] {
			out = append(out, o.ev.Command)
		}
		return out
	}
	assert.Equal(t, []string{"PRIVMSG", "JOIN", "PART", "NICK", "AWAY", "MODE", "PRIVMSG", "PRIVMSG", "TAGMSG"},
		lines(classInteractive))
	assert.Equal(t, []string{"NAMES", "LIST"}, lines(classBackground))
	assert.Equal(t, []string{"TAGMSG"}, lines(classDroppable))
}

func TestClient_SelfJoinQueriesAreBackground(t *testing.T) {
	c := newTestClient(t)
	c.OnEvent(func(Event) {})
	c.sendq.begin()
	before := c.sendq.available()
	c.girc.RunHandlers(&girc.Event{
		Command: girc.JOIN,
		Source:  &girc.Source{Name: c.girc.GetNick(), Ident: "u", Host: "h"},
		Params:  []string{"#chan"},
	})
	c.sendq.mu.Lock()
	bg := c.sendq.queues[classBackground]
	c.sendq.mu.Unlock()
	require.Len(t, bg, 2)
	assert.Equal(t, "MODE #chan", bg[0].ev.String())
	assert.Equal(t, "WHO #chan", bg[1].ev.String())
	// girc's own WHOX + MODE never reach the wire (autoQueryFilter), so
	// nothing is charged for them.
	assert.InDelta(t, before, c.sendq.available(), 0.1)
}

func TestClient_CTCPRepliesQueuedAndCoalesced(t *testing.T) {
	// A CTCP VERSION flood from one nick yields one queued reply, as a
	// droppable line, instead of an unpaced reply per request.
	c := newTestClient(t)
	c.sendq.begin()
	for i := 0; i < 50; i++ {
		c.girc.RunHandlers(&girc.Event{
			Command: girc.PRIVMSG,
			Source:  &girc.Source{Name: "bob", Ident: "b", Host: "h"},
			Params:  []string{"tester", "\x01VERSION\x01"},
		})
	}
	require.Eventually(t, func() bool {
		c.sendq.mu.Lock()
		defer c.sendq.mu.Unlock()
		return len(c.sendq.queues[classDroppable]) == 1
	}, time.Second, time.Millisecond)
	time.Sleep(20 * time.Millisecond) // any stray async reply would land now
	c.sendq.mu.Lock()
	defer c.sendq.mu.Unlock()
	d := c.sendq.queues[classDroppable]
	require.Len(t, d, 1)
	assert.Equal(t, girc.NOTICE, d[0].ev.Command)
	assert.Equal(t, "bob", d[0].ev.Params[0])
	assert.Contains(t, d[0].ev.Params[1], "\x01VERSION ")
	assert.Empty(t, c.sendq.queues[classInteractive])
}
