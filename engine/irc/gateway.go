package irc

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
)

// The browser build reaches IRC through a WebSocket gateway (webircgateway
// in gateway mode): each WebSocket text message is one IRC line, and the
// first line names the network — `HOST irc.example.net:+6697` (+ = TLS
// upstream, done by the gateway; ` insecure` skips its certificate check
// for a server the user marked self-signed). gatewayConn turns such a
// message socket into the byte-stream net.Conn the engine and girc read
// and write. It is transport-agnostic (msgSocket) so it's tested natively;
// dial_js.go backs it with the browser's WebSocket.

// GatewayURL is the WebSocket URL of the IRC gateway (browser build only;
// set by the wasm entry point before any connection).
var gatewayURL struct {
	sync.Mutex
	url string
}

// SetGatewayURL sets the gateway the browser build dials.
func SetGatewayURL(u string) {
	gatewayURL.Lock()
	gatewayURL.url = u
	gatewayURL.Unlock()
}

func currentGatewayURL() string {
	gatewayURL.Lock()
	defer gatewayURL.Unlock()
	return gatewayURL.url
}

// gatewayHostLine is the first line sent to the gateway for cfg.
func gatewayHostLine(cfg Config) string {
	port := strconv.Itoa(cfg.Port)
	if cfg.TLS {
		port = "+" + port
	}
	line := "HOST " + cfg.Hostname + ":" + port
	if cfg.TLS && cfg.TLSInsecure {
		line += " insecure"
	}
	return line
}

// msgSocket is a message-oriented socket: Send writes one text message;
// incoming messages arrive on Messages until it's closed (then Err says
// why).
type msgSocket interface {
	Send(msg string) error
	Messages() <-chan string
	Done() <-chan struct{}
	Err() error
	Close() error
}

var errGatewayClosed = errors.New("irc gateway connection closed")

type gatewayAddr string

func (a gatewayAddr) Network() string { return "ws" }
func (a gatewayAddr) String() string  { return string(a) }

type gatewayConn struct {
	sock   msgSocket
	remote gatewayAddr

	rmu     sync.Mutex
	pending []byte

	dmu      sync.Mutex
	deadline time.Time

	wmu  sync.Mutex
	wbuf []byte
}

func newGatewayConn(sock msgSocket, remote string) *gatewayConn {
	return &gatewayConn{sock: sock, remote: gatewayAddr(remote)}
}

func (g *gatewayConn) Read(p []byte) (int, error) {
	g.rmu.Lock()
	defer g.rmu.Unlock()
	for len(g.pending) == 0 {
		var timeout <-chan time.Time
		g.dmu.Lock()
		dl := g.deadline
		g.dmu.Unlock()
		if !dl.IsZero() {
			d := time.Until(dl)
			if d <= 0 {
				return 0, os.ErrDeadlineExceeded
			}
			t := time.NewTimer(d)
			timeout = t.C
			defer t.Stop()
		}
		select {
		case m, ok := <-g.sock.Messages():
			if !ok {
				return 0, io.EOF
			}
			if m == "" {
				continue
			}
			g.pending = append(g.pending, m...)
			if m[len(m)-1] != '\n' {
				g.pending = append(g.pending, '\r', '\n')
			}
		case <-timeout:
			return 0, os.ErrDeadlineExceeded
		}
	}
	n := copy(p, g.pending)
	g.pending = g.pending[n:]
	return n, nil
}

// Write sends each complete line as one message (without its line ending);
// a partial line waits for its newline.
func (g *gatewayConn) Write(p []byte) (int, error) {
	g.wmu.Lock()
	defer g.wmu.Unlock()
	select {
	case <-g.sock.Done():
		return 0, errGatewayClosed
	default:
	}
	g.wbuf = append(g.wbuf, p...)
	for {
		i := bytes.IndexByte(g.wbuf, '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimRight(g.wbuf[:i], "\r")
		g.wbuf = g.wbuf[i+1:]
		if len(line) == 0 {
			continue
		}
		if err := g.sock.Send(string(line)); err != nil {
			return 0, err
		}
	}
	g.wbuf = append([]byte(nil), g.wbuf...)
	return len(p), nil
}

func (g *gatewayConn) Close() error                     { return g.sock.Close() }
func (g *gatewayConn) LocalAddr() net.Addr              { return gatewayAddr("browser") }
func (g *gatewayConn) RemoteAddr() net.Addr             { return g.remote }
func (g *gatewayConn) SetWriteDeadline(time.Time) error { return nil }

func (g *gatewayConn) SetDeadline(t time.Time) error { return g.SetReadDeadline(t) }

// SetReadDeadline applies to the next Read (a Read already waiting keeps
// its own deadline; girc sets it before each read).
func (g *gatewayConn) SetReadDeadline(t time.Time) error {
	g.dmu.Lock()
	g.deadline = t
	g.dmu.Unlock()
	return nil
}
