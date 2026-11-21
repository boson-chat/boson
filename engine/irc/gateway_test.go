package irc

import (
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fakeSocket struct {
	mu   sync.Mutex
	sent []string
	in   chan string
	done chan struct{}
	once sync.Once
}

func newFakeSocket() *fakeSocket {
	return &fakeSocket{in: make(chan string, 16), done: make(chan struct{})}
}

func (f *fakeSocket) Send(m string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, m)
	return nil
}
func (f *fakeSocket) Messages() <-chan string { return f.in }
func (f *fakeSocket) Done() <-chan struct{}   { return f.done }
func (f *fakeSocket) Err() error              { return nil }
func (f *fakeSocket) Close() error {
	f.once.Do(func() { close(f.done); close(f.in) })
	return nil
}

func TestGatewayHostLine(t *testing.T) {
	require.Equal(t, "HOST irc.example.net:6667", gatewayHostLine(Config{Hostname: "irc.example.net", Port: 6667}))
	require.Equal(t, "HOST irc.example.net:+6697", gatewayHostLine(Config{Hostname: "irc.example.net", Port: 6697, TLS: true}))
	require.Equal(t, "HOST znc.local:+6501 insecure", gatewayHostLine(Config{Hostname: "znc.local", Port: 6501, TLS: true, TLSInsecure: true}))
	// insecure only means something with TLS
	require.Equal(t, "HOST h:6667", gatewayHostLine(Config{Hostname: "h", Port: 6667, TLSInsecure: true}))
}

func TestGatewayConnWritesWholeLines(t *testing.T) {
	s := newFakeSocket()
	c := newGatewayConn(s, "wss://gw/webirc/websocket/")
	n, err := c.Write([]byte("NICK a\r\nUSER a 0 * :"))
	require.NoError(t, err)
	require.Equal(t, 20, n)
	_, err = c.Write([]byte("A\r\n\r\nJOIN #x\n"))
	require.NoError(t, err)
	require.Equal(t, []string{"NICK a", "USER a 0 * :A", "JOIN #x"}, s.sent)
	require.NoError(t, c.Close())
	_, err = c.Write([]byte("PING x\r\n"))
	require.ErrorIs(t, err, errGatewayClosed)
}

func TestGatewayConnReadsMessagesAsLines(t *testing.T) {
	s := newFakeSocket()
	c := newGatewayConn(s, "gw")
	s.in <- ":srv 001 a :hi"
	s.in <- ""
	s.in <- "PING :x\r\n"
	buf := make([]byte, 5)
	var got []byte
	for len(got) < len(":srv 001 a :hi\r\nPING :x\r\n") {
		n, err := c.Read(buf)
		require.NoError(t, err)
		got = append(got, buf[:n]...)
	}
	require.Equal(t, ":srv 001 a :hi\r\nPING :x\r\n", string(got))
	require.NoError(t, s.Close())
	_, err := c.Read(buf)
	require.ErrorIs(t, err, io.EOF)
}

func TestGatewayConnReadDeadline(t *testing.T) {
	s := newFakeSocket()
	c := newGatewayConn(s, "gw")
	require.NoError(t, c.SetReadDeadline(time.Now().Add(20*time.Millisecond)))
	start := time.Now()
	_, err := c.Read(make([]byte, 8))
	require.True(t, errors.Is(err, os.ErrDeadlineExceeded))
	require.Less(t, time.Since(start), time.Second)
	require.NoError(t, c.SetReadDeadline(time.Time{}))
	s.in <- "x"
	n, err := c.Read(make([]byte, 8))
	require.NoError(t, err)
	require.Equal(t, 3, n)
	require.Equal(t, "browser", c.LocalAddr().String())
	require.Equal(t, "gw", c.RemoteAddr().String())
}

func TestGatewayURL(t *testing.T) {
	SetGatewayURL("wss://chat.example/webirc/websocket/")
	require.Equal(t, "wss://chat.example/webirc/websocket/", currentGatewayURL())
	SetGatewayURL("")
}
