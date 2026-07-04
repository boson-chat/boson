package irc

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func newTestClient(t *testing.T) *Client {
	t.Helper()
	c, err := New(Config{Hostname: "irc.example.com", Port: 6697, Nick: "tester"})
	require.NoError(t, err)
	return c
}

func setLifeCtx(c *Client, ctx context.Context) {
	c.mu.Lock()
	c.lifeCtx = ctx
	c.mu.Unlock()
}

func TestAfterConnLifetime_CancelsWithConnection(t *testing.T) {
	// A deferred callback scheduled during a connection must NOT run once the
	// connection's context is cancelled — otherwise the post-welcome LIST /
	// services-probe timers fire SendRaw on a torn-down client and leak a
	// goroutine for the full delay after a disconnect.
	c := newTestClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	setLifeCtx(c, ctx)

	fired := make(chan struct{}, 1)
	c.afterConnLifetime(time.Hour, func() { fired <- struct{}{} })
	cancel()

	select {
	case <-fired:
		t.Fatal("callback ran after the connection context was cancelled")
	case <-time.After(150 * time.Millisecond):
		// Good: the goroutine observed cancellation and exited without firing.
	}
}

func TestAfterConnLifetime_FiresWhenTimerElapses(t *testing.T) {
	// The happy path: with a live connection context, the callback still runs
	// after the delay.
	c := newTestClient(t)
	setLifeCtx(c, context.Background())

	fired := make(chan struct{}, 1)
	c.afterConnLifetime(5*time.Millisecond, func() { fired <- struct{}{} })

	select {
	case <-fired:
		// Good.
	case <-time.After(2 * time.Second):
		t.Fatal("callback did not run before the deadline")
	}
}
