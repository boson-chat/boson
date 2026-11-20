package irc

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// fakeKeepalive is a keepalive on a hand-driven clock, recording its PINGs
// and drops.
type fakeKeepalive struct {
	*keepalive
	clock time.Time
	pings []string
	drops int
}

func newFakeKeepalive() *fakeKeepalive {
	f := &fakeKeepalive{keepalive: newKeepalive(), clock: time.Unix(1_000_000, 0)}
	f.now = func() time.Time { return f.clock }
	f.send = func(token string) { f.pings = append(f.pings, token) }
	f.drop = func() { f.drops++ }
	f.reset()
	f.welcomed.Store(true)
	return f
}

// advance moves the clock in tick steps, running the loop each tick.
func (f *fakeKeepalive) advance(d time.Duration) {
	for end := f.clock.Add(d); f.clock.Before(end); {
		f.clock = f.clock.Add(f.tick)
		f.step()
	}
}

func TestKeepalive_PingsAfterQuiet(t *testing.T) {
	f := newFakeKeepalive()
	f.advance(keepaliveInterval - time.Second)
	assert.Empty(t, f.pings, "no PING while the interval hasn't passed")
	f.advance(time.Second)
	assert.Len(t, f.pings, 1)
}

func TestKeepalive_IncomingTrafficDefersPing(t *testing.T) {
	f := newFakeKeepalive()
	for range 5 {
		f.advance(keepaliveInterval / 2)
		f.touch()
	}
	assert.Empty(t, f.pings, "a busy connection needs no PING")
}

func TestKeepalive_AnyDataAnswers(t *testing.T) {
	f := newFakeKeepalive()
	f.advance(keepaliveInterval)
	assert.Len(t, f.pings, 1)
	f.advance(keepaliveWait / 2)
	f.touch() // a PRIVMSG, not the PONG: still proof of life
	f.advance(keepaliveWait * 2)
	assert.Len(t, f.pings, 1, "answered: no retries")
	assert.Zero(t, f.drops)
}

func TestKeepalive_RetriesThenDrops(t *testing.T) {
	f := newFakeKeepalive()
	f.advance(keepaliveInterval)
	f.advance(keepaliveWait)
	assert.Len(t, f.pings, 2, "first retry after one wait")
	assert.Zero(t, f.drops)
	f.advance(keepaliveWait)
	assert.Len(t, f.pings, 1+keepaliveRetries)
	assert.Zero(t, f.drops, "the last retry still gets its wait")
	f.advance(keepaliveWait)
	assert.Equal(t, 1, f.drops)
	assert.Len(t, f.pings, 1+keepaliveRetries)
}

func TestKeepalive_LateAnswerOnRetrySaves(t *testing.T) {
	f := newFakeKeepalive()
	f.advance(keepaliveInterval + 2*keepaliveWait) // two PINGs unanswered
	f.advance(keepaliveWait - time.Second)
	f.touch()
	f.advance(2 * time.Second)
	assert.Zero(t, f.drops)
	f.advance(keepaliveInterval - 3*time.Second)
	assert.Len(t, f.pings, 1+keepaliveRetries, "next round starts a full interval after the answer")
}

func TestKeepalive_SuspensionStartsAFreshCheck(t *testing.T) {
	f := newFakeKeepalive()
	f.advance(keepaliveInterval + 2*keepaliveWait) // mid-check, two misses
	// The app is suspended for ten minutes: no ticks run.
	f.clock = f.clock.Add(10 * time.Minute)
	f.step()
	assert.Zero(t, f.drops, "the suspension's silence isn't counted")
	assert.Len(t, f.pings, 4, "a fresh PING on wake")
	f.advance(keepaliveWait)
	assert.Zero(t, f.drops, "and the retries start over")
}

func TestKeepalive_CheckUsesItsOwnWait(t *testing.T) {
	f := newFakeKeepalive()
	verdict := f.check(5 * time.Second)
	assert.Len(t, f.pings, 1, "a check PINGs at once")
	f.advance(5 * time.Second)
	assert.Len(t, f.pings, 2, "retried after the check's wait")
	f.clock = f.clock.Add(time.Millisecond)
	f.touch()
	f.advance(time.Second)
	select {
	case ok := <-verdict:
		assert.True(t, ok)
	default:
		t.Fatal("no verdict")
	}
}

func TestKeepalive_CheckFailsAfterRetries(t *testing.T) {
	f := newFakeKeepalive()
	verdict := f.check(5 * time.Second)
	f.advance(time.Duration(1+keepaliveRetries) * 5 * time.Second)
	assert.Equal(t, 1, f.drops)
	assert.False(t, <-verdict)
}

func TestKeepalive_CheckJoinsOutstandingPing(t *testing.T) {
	f := newFakeKeepalive()
	f.advance(keepaliveInterval)
	f.check(5 * time.Second)
	assert.Len(t, f.pings, 1, "no second PING while one is out")
	f.advance(5 * time.Second)
	assert.Len(t, f.pings, 2, "the shorter wait applies")
}

func TestKeepalive_NothingBeforeWelcome(t *testing.T) {
	f := newFakeKeepalive()
	f.welcomed.Store(false)
	f.advance(5 * keepaliveInterval)
	assert.Empty(t, f.pings, "clients don't PING during registration")
	assert.False(t, <-f.check(time.Second))
}
