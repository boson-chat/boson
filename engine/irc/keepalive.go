package irc

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lrstanley/girc"
)

// Keepalive: the engine's own PING schedule and liveness check, in place of
// girc's (which only counts the PONG to its own PING, and gives up after one
// missed reply).
//
// No IRC spec sets these numbers. RFC 1459 §4.6.2 and RFC 2812 §3.7.2 say
// only that PINGs go out "at regular intervals if no other activity" and that
// a connection that doesn't answer "within a set amount of time" is closed;
// Modern IRC (modern.ircdocs.horse) and IRCv3 define no timing either, and no
// ISUPPORT token or CAP tells a client the server's interval. So the values
// are chosen for what's out there:
//
//   - Servers ping a quiet client after about 90s and drop it at about 150s
//     (Ergo's defaults; most ircds are similar). Any line from the client
//     resets the server's timer, so a PING after 60s of quiet keeps us well
//     clear of it.
//   - Mobile carriers' NATs forget idle TCP flows after a few minutes; a
//     line every minute keeps the mapping alive.
//   - A phone's radio can take seconds to wake and a busy link can queue a
//     burst of backlog ahead of our PONG, so one slow reply is not a dead
//     connection: each PING gets keepaliveWait, and keepaliveRetries more
//     are sent before giving up. Any bytes from the server count as an
//     answer, not just the PONG.
//
// Worst case a dead connection is noticed after keepaliveInterval +
// (1+keepaliveRetries)*keepaliveWait = 2 minutes of silence, before the
// server's own 150s timeout. A check asked for by the app (Probe: back from
// the background, a network change) starts at once with a shorter wait.
const (
	keepaliveInterval = 60 * time.Second
	keepaliveWait     = 20 * time.Second
	keepaliveRetries  = 2
	keepaliveTick     = time.Second
	// A gap this long between ticks means the process was suspended (a
	// phone app in the background): the clock moved on but nothing could
	// read the socket, so the silence says nothing. Start a fresh check
	// instead of counting it.
	keepaliveSuspendGap = 10 * time.Second
)

const keepaliveTokenPrefix = "boson-ka-"

type keepalive struct {
	interval, wait time.Duration
	retries        int
	tick           time.Duration
	suspendGap     time.Duration

	// lastRx is the wall-clock time (UnixNano) bytes last came in.
	lastRx atomic.Int64
	// welcomed: registration finished (RPL_WELCOME). Clients shouldn't PING
	// during registration (Modern IRC, PING message).
	welcomed atomic.Bool

	mu       sync.Mutex
	pingAt   time.Time // when the outstanding check's last PING went out; zero = none
	curWait  time.Duration
	misses   int
	waiters  []chan bool
	lastTick time.Time
	seq      uint64

	send func(token string)
	drop func()
	now  func() time.Time
}

func newKeepalive() *keepalive {
	return &keepalive{
		interval:   keepaliveInterval,
		wait:       keepaliveWait,
		retries:    keepaliveRetries,
		tick:       keepaliveTick,
		suspendGap: keepaliveSuspendGap,
		// Wall clock, not monotonic: a suspended app's monotonic clock may
		// not advance, which would hide the suspension from the gap check.
		now: func() time.Time { return time.Now().Round(0) },
	}
}

// touch records incoming bytes: proof the connection is alive.
func (k *keepalive) touch() { k.lastRx.Store(k.now().UnixNano()) }

func (k *keepalive) reset() {
	k.mu.Lock()
	k.pingAt, k.misses, k.lastTick = time.Time{}, 0, time.Time{}
	waiters := k.waiters
	k.waiters = nil
	k.mu.Unlock()
	k.welcomed.Store(false)
	k.touch()
	for _, w := range waiters {
		w <- false
	}
}

// pingLocked sends a PING for the current check.
func (k *keepalive) pingLocked(now time.Time) {
	k.pingAt = now
	k.seq++
	if k.send != nil {
		k.send(fmt.Sprintf("%s%d", keepaliveTokenPrefix, k.seq))
	}
}

// check starts a check now, with the given wait per PING (a shorter one
// tightens a check already under way). The channel gets the verdict: true
// once anything arrives, false when the connection is dropped.
func (k *keepalive) check(wait time.Duration) <-chan bool {
	ch := make(chan bool, 1)
	if !k.welcomed.Load() {
		ch <- false
		return ch
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	k.waiters = append(k.waiters, ch)
	if k.pingAt.IsZero() {
		k.curWait, k.misses = wait, 0
		k.pingLocked(k.now())
	} else if wait < k.curWait {
		k.curWait = wait
	}
	return ch
}

// step runs one tick. Reports whether the connection was given up on.
func (k *keepalive) step() bool {
	if !k.welcomed.Load() {
		return false
	}
	now := k.now()
	rx := time.Unix(0, k.lastRx.Load())

	k.mu.Lock()
	suspended := !k.lastTick.IsZero() && now.Sub(k.lastTick) > k.suspendGap
	k.lastTick = now
	var notify []chan bool
	verdict, dead := false, false
	switch {
	case !k.pingAt.IsZero() && rx.After(k.pingAt):
		// Answered (by the PONG or anything else).
		k.pingAt, k.misses = time.Time{}, 0
		notify, verdict = k.waiters, true
		k.waiters = nil
	case suspended:
		// Back from suspension: whatever was outstanding couldn't have been
		// read. Check afresh, from the top of the retries.
		if k.pingAt.IsZero() {
			k.curWait = k.wait
		}
		k.misses = 0
		k.pingLocked(now)
	case !k.pingAt.IsZero() && now.Sub(k.pingAt) >= k.curWait:
		if k.misses < k.retries {
			k.misses++
			k.pingLocked(now)
		} else {
			k.pingAt, k.misses = time.Time{}, 0
			notify, dead = k.waiters, true
			k.waiters = nil
		}
	case k.pingAt.IsZero() && now.Sub(rx) >= k.interval:
		k.curWait, k.misses = k.wait, 0
		k.pingLocked(now)
	}
	k.mu.Unlock()

	if dead && k.drop != nil {
		k.drop()
	}
	for _, w := range notify {
		w <- verdict
	}
	return dead
}

// run ticks until ctx ends or the connection is given up on.
func (k *keepalive) run(ctx context.Context) {
	t := time.NewTicker(k.tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if k.step() {
				return
			}
		}
	}
}

// installKeepalive wires the keepalive to this client: PINGs go straight to
// girc (ahead of the paced queue, which could hold them behind a backlog),
// a dead connection is dropped like Abort's (no QUIT: nothing would receive
// it), and RPL_WELCOME arms it.
func (c *Client) installKeepalive() {
	k := newKeepalive()
	k.send = func(token string) {
		c.girc.Send(&girc.Event{Command: girc.PING, Params: []string{token}})
	}
	k.drop = c.Abort
	c.girc.Handlers.Add(girc.RPL_WELCOME, func(_ *girc.Client, _ girc.Event) {
		k.touch()
		k.welcomed.Store(true)
	})
	c.keepalive = k
}
