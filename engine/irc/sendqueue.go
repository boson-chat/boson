package irc

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/lrstanley/girc"
)

// sendQueue is the per-client outbound line queue. It replaces girc's
// built-in flood control (Config.AllowFlood is true), which paced by
// sleeping *in the caller* of Client.Send: the engine calls girc from the IPC
// dispatch loop, so once the post-connect burst (WHO per channel, LIST,
// services probes, typing TAGMSGs) had run up girc's write-delay debt every
// user message slept 1–2s and stalled every other command on the websocket
// session — for all servers. Through a bouncer it was paced twice.
//
// Now every engine-originated line is enqueued (never blocks) and ONE drainer
// goroutine per connection lifetime pops lines in priority order, paces them
// with a token bucket, and hands them to girc.Client.Send, which still splits
// over-long lines (event.split) and writes to girc's tx channel. Lines girc
// writes itself — registration (CAP/NICK/USER/PASS/SASL), PING/PONG, QUIT —
// go through girc's unexported write() and never touch this queue, so
// keepalives and registration are never delayed by it.
//
// Ordering: three classes, strictly prioritised; FIFO within a class. Every
// user-visible line (PRIVMSG/NOTICE/JOIN/…) is interactive, so a multi-line
// paste or a JOIN-then-PRIVMSG keeps its order. Background lines can be
// overtaken by interactive ones, which is the point: an automatic WHO must
// never delay what the user typed.
type sendQueue struct {
	mu     sync.Mutex
	queues [numSendClasses][]outbound
	// active is true while a drainer owns the queue (one Connect lifetime).
	// Lines enqueued outside it are dropped, like girc drops writes on a nil
	// connection: there is nobody to send them.
	active bool
	bucket tokenBucket
	// wake is signalled (non-blocking, cap 1) on every enqueue; see
	// dispatchQueue for why coalescing is fine.
	wake chan struct{}

	// pacing returns the limits to apply right now. Called on every
	// scheduling decision so a bouncer detected mid-connection switches
	// profile without restarting the drainer. Called without mu held.
	pacing func() pacing
	// now and newTimer are the clock; tests substitute fakes.
	now      func() time.Time
	newTimer func(d time.Duration) (<-chan time.Time, func() bool)
}

type sendClass int

const (
	// classInteractive: anything the user did — messages, JOIN/PART/NICK/
	// AWAY/TOPIC/MODE/KICK/INVITE, raw commands, NickServ IDENTIFY, bouncer
	// connect/disconnect.
	classInteractive sendClass = iota
	// classBackground: automatic traffic the user isn't waiting on — WHO on
	// self-join, auto-LIST and the 421 retry, services VERSION/HELP probes,
	// the bouncer USERHOST self-probe, NAMES refresh, directory LIST.
	classBackground
	// classDroppable: +typing TAGMSGs and CTCP auto-replies. Coalesced per
	// key (only the newest line per key stays queued) and dropped instead of
	// sent when the bucket is low, so they never delay anything else.
	classDroppable
	numSendClasses
)

type outbound struct {
	ev    *girc.Event
	class sendClass
	// key coalesces droppable lines ("" = no coalescing).
	key string
	// at is when the (latest coalesced) line was enqueued; droppable lines
	// older than droppableTTL are discarded instead of sent.
	at time.Time
}

// pacing is a token-bucket configuration. rate <= 0 means unlimited.
type pacing struct {
	burst float64 // bucket capacity, in lines
	rate  float64 // refill, lines per second
}

var (
	// directPacing: burst 6, then 1 line/s.
	//
	// Servers kill a client for "Excess Flood" when its receive queue backs
	// up: Solanum/Charybdis (Libera, OFTC-like setups) process roughly one
	// line per second after a short burst and disconnect once ~20 lines are
	// pending; InspIRCd's default <connect commandrate="1000"
	// threshold="10"> is 1 command/s with a penalty threshold of 10. A
	// burst of 6 stays well clear of both thresholds even with the girc-
	// internal WHO/MODE pair each self-JOIN adds (charged to the bucket),
	// and 1/s matches what those servers drain, so the server-side queue
	// never grows. For comparison irssi sends 5 at once then one per 2.2s,
	// WeeChat 2s per line after a small burst, HexChat ~2s; we are a bit
	// faster sustained because user lines are no longer competing with
	// background traffic (they jump the queue), so 1/s is what a fast
	// typist or a short paste actually experiences.
	directPacing = pacing{burst: 6, rate: 1}

	// bouncerPacing: burst 50, 20 lines/s — effectively no client-side
	// throttling. ZNC paces the upstream itself (FloodRate ~2/s, FloodBurst
	// 9 by default) and buffers whatever we send it, so pacing here too just
	// doubles the delay (the original symptom). We still keep a very
	// generous cap rather than none, so an engine bug or a pathological
	// paste can't spin thousands of lines per second into the bouncer.
	bouncerPacing = pacing{burst: 50, rate: 20}
)

// droppableMinTokens: a droppable line is sent only while at least this many
// tokens remain, i.e. while there is headroom for a real line right behind it.
// Below that it WAITS (lowest priority — any real line enqueued meanwhile
// wakes the drainer and goes first) rather than being dropped: dropping here
// lost the "typing…" notification on every channel join, because the
// automatic WHO/MODE burst leaves the bucket just under this threshold.
const droppableMinTokens = 2

// droppableTTL: a droppable line still queued after this long is stale (an
// IRCv3 "active" typing state is only meaningful for a few seconds; a CTCP
// auto-reply this late is pointless) and is discarded instead of sent.
const droppableTTL = 5 * time.Second

// interactiveReserve: background lines are only sent while more than this
// many tokens would remain, so an automatic burst (WHO per channel on
// connect, LIST, probes) can never spend the whole bucket — the user's next
// line always finds a token waiting instead of queueing behind a refill.
const interactiveReserve = 2

func newSendQueue(p func() pacing) *sendQueue {
	return &sendQueue{
		wake:   make(chan struct{}, 1),
		pacing: p,
		now:    time.Now,
		newTimer: func(d time.Duration) (<-chan time.Time, func() bool) {
			t := time.NewTimer(d)
			return t.C, t.Stop
		},
	}
}

// tokenBucket holds the token count; capacity and rate come from pacing.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

func (b *tokenBucket) refill(now time.Time, p pacing) {
	if dt := now.Sub(b.last).Seconds(); dt > 0 {
		b.tokens += dt * p.rate
	}
	b.last = now
	if b.tokens > p.burst {
		b.tokens = p.burst
	}
}

// begin readies the queue for a new connection: empty, full bucket, active.
func (q *sendQueue) begin() {
	p := q.pacing()
	q.mu.Lock()
	defer q.mu.Unlock()
	q.queues = [numSendClasses][]outbound{}
	q.bucket = tokenBucket{tokens: p.burst, last: q.now()}
	q.active = true
}

// end drops everything queued and deactivates the queue.
func (q *sendQueue) end() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.queues = [numSendClasses][]outbound{}
	q.active = false
}

// enqueue adds ev to its class queue. Never blocks: safe from the IPC
// dispatch loop, girc's exec loop and timer goroutines alike.
func (q *sendQueue) enqueue(ev *girc.Event, class sendClass, key string) {
	if ev == nil {
		return
	}
	q.mu.Lock()
	if !q.active {
		q.mu.Unlock()
		return
	}
	if class == classDroppable && key != "" {
		// Coalesce in place: keep the slot (and so the relative order of
		// different keys) but carry only the newest state.
		for i := range q.queues[classDroppable] {
			if q.queues[classDroppable][i].key == key {
				q.queues[classDroppable][i].ev = ev
				q.queues[classDroppable][i].at = q.now()
				q.mu.Unlock()
				q.nudge()
				return
			}
		}
	}
	if class != classDroppable {
		// A message to a target supersedes a still-queued active/paused
		// typing state for it: the droppable class goes out after the
		// message, and a stale "active" arriving after the text would show
		// the user typing again. A queued "done" is harmless and kept.
		if t := messageTarget(ev); t != "" {
			q.removeStaleTypingLocked(typingKey(t))
		}
	}
	q.queues[class] = append(q.queues[class], outbound{ev: ev, class: class, key: key, at: q.now()})
	q.mu.Unlock()
	q.nudge()
}

func (q *sendQueue) nudge() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *sendQueue) removeStaleTypingLocked(key string) {
	d := q.queues[classDroppable]
	for i := range d {
		if d[i].key == key {
			if state, _ := d[i].ev.Tags.Get("+typing"); state == "done" {
				return
			}
			q.queues[classDroppable] = append(d[:i:i], d[i+1:]...)
			return
		}
	}
}

// charge debits n extra tokens for lines written outside the queue's own
// accounting (a long message girc split into several lines; the WHO + MODE
// girc sends by itself on every self-JOIN). The balance may go negative, down
// to -burst, so the debt is paid back before the next line but can never
// starve the queue for longer than one bucket's worth.
func (q *sendQueue) charge(n float64) {
	if n <= 0 {
		return
	}
	p := q.pacing()
	if p.rate <= 0 {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.bucket.refill(q.now(), p)
	q.bucket.tokens -= n
	if q.bucket.tokens < -p.burst {
		q.bucket.tokens = -p.burst
	}
}

// next returns the line to send now, or (nil, wait) where wait > 0 is how
// long until a token is available and 0 means the queue is empty. Droppable
// lines whose turn comes while tokens are low are discarded here.
func (q *sendQueue) next() (*girc.Event, time.Duration) {
	p := q.pacing()
	q.mu.Lock()
	defer q.mu.Unlock()
	limited := p.rate > 0
	if limited {
		q.bucket.refill(q.now(), p)
	}
	for {
		class := -1
		for i := range q.queues {
			if len(q.queues[i]) > 0 {
				class = i
				break
			}
		}
		if class < 0 {
			return nil, 0
		}
		if sendClass(class) == classDroppable && q.now().Sub(q.queues[class][0].at) > droppableTTL {
			q.popLocked(class) // stale: discard rather than send late
			continue
		}
		need := 1.0
		switch sendClass(class) {
		case classBackground:
			need += interactiveReserve
		case classDroppable:
			need = droppableMinTokens
		}
		if limited && q.bucket.tokens < need {
			wait := time.Duration((need - q.bucket.tokens) / p.rate * float64(time.Second))
			if wait < time.Millisecond {
				wait = time.Millisecond
			}
			return nil, wait
		}
		if limited {
			q.bucket.tokens--
		}
		return q.popLocked(class).ev, 0
	}
}

// available returns the current token balance (after refill). For tests and
// diagnostics.
func (q *sendQueue) available() float64 {
	p := q.pacing()
	q.mu.Lock()
	defer q.mu.Unlock()
	q.bucket.refill(q.now(), p)
	return q.bucket.tokens
}

func (q *sendQueue) popLocked(class int) outbound {
	o := q.queues[class][0]
	q.queues[class][0] = outbound{}
	q.queues[class] = q.queues[class][1:]
	if len(q.queues[class]) == 0 {
		q.queues[class] = nil
	}
	return o
}

// run drains the queue until ctx is cancelled or stop is closed, handing
// each line to write. write returns how many lines beyond the first the
// event turned into on the wire (girc splits long messages), which are
// charged to the bucket. On exit whatever is still queued is dropped — the
// connection is gone. A write in flight is not interrupted; girc bounds it
// (its write() gives up after 30s on a wedged socket).
func (q *sendQueue) run(ctx context.Context, stop <-chan struct{}, write func(*girc.Event) int) {
	defer q.end()
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-stop:
			return
		default:
		}
		ev, wait := q.next()
		if ev != nil {
			if extra := write(ev); extra > 0 {
				q.charge(float64(extra))
			}
			continue
		}
		var timer <-chan time.Time
		stopTimer := func() bool { return false }
		if wait > 0 {
			timer, stopTimer = q.newTimer(wait)
		}
		select {
		case <-q.wake:
		case <-timer:
		case <-ctx.Done():
		case <-stop:
		}
		stopTimer()
	}
}

// startSendQueue launches the drainer for one connection lifetime and returns
// a stop func that signals it and waits for it to exit (no goroutine leak).
// Mirrors startDispatch.
func (c *Client) startSendQueue(ctx context.Context) (stop func()) {
	c.sendq.begin()
	stopCh := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.sendq.run(ctx, stopCh, c.writeOutbound)
	}()
	var once sync.Once
	return func() {
		once.Do(func() { close(stopCh) })
		<-done
	}
}

// writeOutbound hands one queued event to girc. Send splits over-long
// PRIVMSG/NOTICE lines; the extra lines are reported so they're paced too.
// With AllowFlood set, Send no longer sleeps — the only way it blocks is
// girc's tx channel being full (socket wedged), and that's this goroutine's
// problem, not the caller's.
func (c *Client) writeOutbound(ev *girc.Event) (extra int) {
	if max := c.girc.MaxEventLength(); max > 0 {
		if l := ev.Len(); l > max {
			extra = (l - 1) / max
		}
	}
	c.girc.Send(ev)
	return extra
}

// send enqueues ev with the given class. The single entry point for every
// line the engine originates.
func (c *Client) send(ev *girc.Event, class sendClass) {
	c.sendq.enqueue(ev, class, "")
}

// sendRawLine parses line as a raw IRC line and enqueues it.
func (c *Client) sendRawLine(line string, class sendClass) {
	if ev := girc.ParseEvent(line); ev != nil {
		c.send(ev, class)
	}
}

// pacing picks the token-bucket profile for this connection: generous for a
// bouncer (declared by the renderer or detected on the wire), strict for a
// direct server connection.
func (c *Client) pacing() pacing {
	if c.bouncer.isBouncer() {
		return bouncerPacing
	}
	return directPacing
}

// messageTarget returns the target of a PRIVMSG/NOTICE/TAGMSG, else "".
func messageTarget(ev *girc.Event) string {
	switch ev.Command {
	case girc.PRIVMSG, girc.NOTICE:
		if len(ev.Params) > 0 {
			return ev.Params[0]
		}
	}
	return ""
}

func typingKey(target string) string { return "typing:" + girc.ToRFC1459(target) }

// isTypingOnly reports whether tags carry only the +typing client tag.
func isTypingOnly(tags map[string]string) bool {
	if len(tags) != 1 {
		return false
	}
	_, ok := tags["+typing"]
	return ok
}

// installCTCPReplies re-registers girc's default CTCP auto-replies so they go
// through the send queue as droppable lines. girc's defaults call
// Cmd.SendCTCPReply → Send directly; with AllowFlood on, a CTCP flood
// (someone spamming VERSION/PING at us or at a channel) would otherwise make
// us answer every one unpaced and get us killed for excess flood. Replies are
// coalesced per (requester, command) and dropped while the bucket is low —
// the classic client-side CTCP flood protection. The reply bodies are the
// same as girc's.
//
// FINGER (needs girc's unexported idle clock) keeps girc's own handler, as
// does the ERRMSG girc sends for unknown CTCP commands; both are rare.
func (c *Client) installCTCPReplies() {
	reply := func(ctcp girc.CTCPEvent, text string) {
		if ctcp.Reply || ctcp.Source == nil {
			return
		}
		target := ctcp.Source.ID()
		body := girc.EncodeCTCPRaw(ctcp.Command, text)
		if body == "" {
			return
		}
		c.sendq.enqueue(&girc.Event{Command: girc.NOTICE, Params: []string{target, body}},
			classDroppable, "ctcp:"+girc.ToRFC1459(target)+":"+ctcp.Command)
	}
	c.girc.CTCP.Set(girc.CTCP_PING, func(_ *girc.Client, e girc.CTCPEvent) { reply(e, e.Text) })
	c.girc.CTCP.Set(girc.CTCP_PONG, func(_ *girc.Client, e girc.CTCPEvent) { reply(e, "") })
	c.girc.CTCP.Set(girc.CTCP_VERSION, func(cl *girc.Client, e girc.CTCPEvent) {
		if v := cl.Config.Version; v != "" {
			reply(e, v)
			return
		}
		reply(e, fmt.Sprintf("girc (github.com/lrstanley/girc) using %s (%s, %s)",
			runtime.Version(), runtime.GOOS, runtime.GOARCH))
	})
	c.girc.CTCP.Set(girc.CTCP_SOURCE, func(_ *girc.Client, e girc.CTCPEvent) {
		reply(e, "https://github.com/lrstanley/girc")
	})
	c.girc.CTCP.Set(girc.CTCP_TIME, func(_ *girc.Client, e girc.CTCPEvent) {
		reply(e, ":"+time.Now().Format(time.RFC1123Z))
	})
}
