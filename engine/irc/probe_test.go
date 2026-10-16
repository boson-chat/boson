package irc

import (
	"bufio"
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// probeServer welcomes one client and, when answer is set, answers its
// PINGs; otherwise it reads them and stays silent, like a dead link.
func probeServer(t *testing.T, answer bool) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		cn, err := l.Accept()
		if err != nil {
			return
		}
		t.Cleanup(func() { _ = cn.Close() })
		_, _ = cn.Write([]byte(":srv 001 tester :Welcome\r\n"))
		sc := bufio.NewScanner(cn)
		for sc.Scan() {
			line := sc.Text()
			if answer && strings.HasPrefix(line, "PING ") {
				_, _ = cn.Write([]byte(":srv PONG srv " + strings.TrimPrefix(line, "PING ") + "\r\n"))
			}
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

func connectForProbe(t *testing.T, answer bool) (*Client, chan error) {
	t.Helper()
	c, err := New(Config{Hostname: "127.0.0.1", Port: probeServer(t, answer), Nick: "tester"})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- c.Connect(ctx) }()
	require.Eventually(t, c.girc.IsConnected, 5*time.Second, 5*time.Millisecond)
	return c, done
}

func TestProbe_AliveConnectionAnswers(t *testing.T) {
	c, done := connectForProbe(t, true)
	assert.True(t, c.Probe(2*time.Second))
	assert.True(t, c.girc.IsConnected(), "a live connection stays up")
	select {
	case err := <-done:
		t.Fatalf("Connect returned after a good probe: %v", err)
	default:
	}
}

func TestProbe_SilentConnectionIsDropped(t *testing.T) {
	c, done := connectForProbe(t, false)
	start := time.Now()
	assert.False(t, c.Probe(300*time.Millisecond))
	assert.Less(t, time.Since(start), 2*time.Second)
	select {
	case <-done: // Connect returned: the session reports disconnected
	case <-time.After(5 * time.Second):
		t.Fatal("Connect did not return after a failed probe")
	}
}

func TestProbe_NotConnected(t *testing.T) {
	c, err := New(Config{Hostname: "127.0.0.1", Port: 1, Nick: "tester"})
	require.NoError(t, err)
	assert.False(t, c.Probe(100*time.Millisecond))
}

func TestPrivmsgAck_ConfirmedByThePong(t *testing.T) {
	c, err := New(Config{Hostname: "127.0.0.1", Port: probeServer(t, true), Nick: "tester"})
	require.NoError(t, err)
	acks := make(chan string, 4)
	c.OnEvent(func(e Event) {
		if e.Kind == KindAck {
			acks <- e.Message
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = c.Connect(ctx) }()
	require.Eventually(t, c.girc.IsConnected, 5*time.Second, 5*time.Millisecond)

	c.PrivmsgAck("#chan", "hello", 7)
	select {
	case n := <-acks:
		assert.Equal(t, "7", n)
	case <-time.After(5 * time.Second):
		t.Fatal("no ACK")
	}
}
