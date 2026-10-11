package irc

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// timedIRCServer is a fake IRC server that answers registration with a 001
// and records every line the client sends with its arrival time, so tests can
// measure end-to-end send latency over a real socket.
type timedIRCServer struct {
	t        *testing.T
	listener net.Listener
	port     int
	welcome  string // source of the 001

	mu       sync.Mutex
	received []timedLine
}

type timedLine struct {
	line string
	at   time.Time
}

func newTimedIRCServer(t *testing.T, welcomeSource string) *timedIRCServer {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	s := &timedIRCServer{t: t, listener: l, port: l.Addr().(*net.TCPAddr).Port, welcome: welcomeSource}
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
		sc := bufio.NewScanner(cn)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r")
			s.mu.Lock()
			s.received = append(s.received, timedLine{line: line, at: time.Now()})
			s.mu.Unlock()
			if strings.HasPrefix(line, "USER ") {
				_, _ = fmt.Fprintf(cn, ":%s 001 tester :Welcome\r\n", s.welcome)
			}
		}
	}()
	t.Cleanup(func() {
		_ = l.Close()
		connMu.Lock()
		if conn != nil {
			_ = conn.Close()
		}
		connMu.Unlock()
		wg.Wait()
	})
	return s
}

// arrival returns when line was received, or the zero time.
func (s *timedIRCServer) arrival(line string) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.received {
		if r.line == line {
			return r.at
		}
	}
	return time.Time{}
}

// linesWithPrefix returns received lines starting with prefix, in order.
func (s *timedIRCServer) linesWithPrefix(prefix string) []timedLine {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []timedLine
	for _, r := range s.received {
		if strings.HasPrefix(r.line, prefix) {
			out = append(out, r)
		}
	}
	return out
}

// connectTimed connects a client to srv and waits for the 001 to be
// processed. The returned func disconnects and waits for Connect to return.
func connectTimed(t *testing.T, srv *timedIRCServer, bouncer bool, setup ...func(*Client)) (*Client, func()) {
	t.Helper()
	c, err := New(Config{Hostname: "127.0.0.1", Port: srv.port, Nick: "tester", Bouncer: bouncer})
	require.NoError(t, err)
	for _, fn := range setup {
		fn(c)
	}
	welcomed := make(chan struct{})
	var once sync.Once
	c.OnEvent(func(e Event) {
		if e.Kind == "001" {
			once.Do(func() { close(welcomed) })
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Connect(ctx) }()
	select {
	case <-welcomed:
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("never welcomed")
	}
	return c, func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("Connect did not return")
		}
	}
}

// quietWelcome suppresses the post-welcome background traffic.
func quietWelcome(c *Client) {
	c.autoListDelay = time.Hour
	c.services.mu.Lock()
	c.services.probeFired = true
	c.services.mu.Unlock()
}

// waitArrival polls for line at srv for up to d; returns the arrival time or
// fails the test.
func waitArrival(t *testing.T, srv *timedIRCServer, line string, d time.Duration) time.Time {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if at := srv.arrival(line); !at.IsZero() {
			return at
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("%q never arrived within %s", line, d)
	return time.Time{}
}

func TestSendQueue_Integration_UserMessageJumpsBackgroundBurst(t *testing.T) {
	// The post-connect burst (WHO per channel, NAMES, probes) used to fill
	// girc's flood-control debt so the user's first message waited seconds —
	// and the caller (the IPC loop) slept through it. Now background lines
	// queue behind the user's, and the calls themselves return at once.
	srv := newTimedIRCServer(t, "irc.example.com")
	c, disconnect := connectTimed(t, srv, false)
	defer disconnect()

	start := time.Now()
	for i := 0; i < 20; i++ {
		c.Names(fmt.Sprintf("#bg%d", i)) // background class
	}
	c.Privmsg("#chan", "hello")
	callTime := time.Since(start)
	at := waitArrival(t, srv, "PRIVMSG #chan hello", 5*time.Second)
	latency := at.Sub(start)
	t.Logf("20 background + 1 user line: calls returned in %s, PRIVMSG arrived after %s", callTime, latency)
	require.Less(t, callTime, 50*time.Millisecond, "enqueue blocked the caller")
	require.Less(t, latency, 100*time.Millisecond, "user PRIVMSG stuck behind background burst")
}

func TestSendQueue_Integration_UserBurstInOrder(t *testing.T) {
	srv := newTimedIRCServer(t, "irc.example.com")
	// Measure the idle-connection case: switch off the welcome work's
	// background lines (services probes, auto-LIST), which would otherwise
	// spend part of the bucket down to the interactive reserve.
	c, disconnect := connectTimed(t, srv, false, quietWelcome)
	defer disconnect()
	require.Eventually(t, func() bool { return c.sendq.available() >= directPacing.burst-1e-6 },
		5*time.Second, 10*time.Millisecond)

	start := time.Now()
	for i := 0; i < 6; i++ {
		c.Privmsg("#chan", fmt.Sprintf("line%d", i))
	}
	last := waitArrival(t, srv, "PRIVMSG #chan line5", 5*time.Second)
	t.Logf("6-line burst delivered in %s", last.Sub(start))
	require.Less(t, last.Sub(start), 1500*time.Millisecond)
	got := srv.linesWithPrefix("PRIVMSG #chan ")
	require.Len(t, got, 6)
	for i, l := range got {
		require.Equal(t, fmt.Sprintf("PRIVMSG #chan line%d", i), l.line)
	}
}

func TestSendQueue_Integration_BouncerPacedLikeZNC(t *testing.T) {
	// A bouncer relays upstream at its own flood rate (ZNC: burst 9, then 2s
	// a line) from ONE FIFO. Automatic traffic must stay in our queue, paced
	// at that rate, so a line the user types reaches the network at once
	// instead of after everything already handed to the bouncer.
	srv := newTimedIRCServer(t, "irc.example.com")
	c, disconnect := connectTimed(t, srv, true, quietWelcome)
	defer disconnect()
	// Registration may have spent a few tokens; the user's line only needs
	// the interactive reserve to be there.
	require.Eventually(t, func() bool { return c.sendq.available() >= interactiveReserve+1 },
		10*time.Second, 10*time.Millisecond)

	for i := 0; i < 30; i++ {
		c.Names(fmt.Sprintf("#c%d", i))
	}
	time.Sleep(300 * time.Millisecond)
	start := time.Now()
	c.Privmsg("#chan", "typed")
	got := waitArrival(t, srv, "PRIVMSG #chan typed", 2*time.Second)
	require.Less(t, got.Sub(start), 500*time.Millisecond)
	// Only the burst (minus the interactive reserve) of background lines went
	// out ahead of it — the rest are still queued here, not at the bouncer.
	require.LessOrEqual(t, len(srv.linesWithPrefix("NAMES ")), int(bouncerPacing.burst)-interactiveReserve)

	// Bouncer-local commands never wait for a token.
	start = time.Now()
	for i := 0; i < 20; i++ {
		c.Privmsg("*playback", fmt.Sprintf("PLAY #c%d 0", i))
	}
	got = waitArrival(t, srv, "PRIVMSG *playback :PLAY #c19 0", 2*time.Second)
	require.Less(t, got.Sub(start), 500*time.Millisecond)
}
