package irc

import (
	"bufio"
	"context"
	"crypto/tls"
	"log/slog"
	"net"
	"strconv"

	"github.com/lrstanley/girc"
)

// lineFilterConn wraps a net.Conn and drops any line that girc's parser would
// reject (girc.ParseEvent returns nil) — blank lines, or malformed frames.
//
// girc's readLoop treats an unparseable line as a FATAL error and tears the
// whole connection down. Some servers/bouncers emit such lines (notably a
// CHARCONV-built ngircd, which is known-buggy), which would otherwise cause a
// disconnect → reconnect → re-join → re-replay storm. By filtering with the
// SAME predicate girc uses (ParseEvent == nil), girc's reader never sees a
// line it can't handle, so the connection stays up. We never log line content
// (it may carry message text); only that one was dropped.
type lineFilterConn struct {
	net.Conn
	r       *bufio.Reader
	pending []byte // bytes of the current accepted line still to be served
}

func newLineFilterConn(c net.Conn) *lineFilterConn {
	return &lineFilterConn{Conn: c, r: bufio.NewReader(c)}
}

func (l *lineFilterConn) Read(p []byte) (int, error) {
	for len(l.pending) == 0 {
		line, err := l.r.ReadBytes('\n')
		if len(line) > 0 {
			if girc.ParseEvent(string(line)) != nil {
				l.pending = line
			} else {
				slog.Warn("irc: dropping unparseable line to keep connection alive", "bytes", len(line))
			}
		}
		if err != nil {
			if len(l.pending) == 0 {
				return 0, err
			}
			break // serve the accepted line; the error surfaces on the next Read
		}
	}
	n := copy(p, l.pending)
	l.pending = l.pending[n:]
	return n, nil
}

// dial establishes the transport girc will use, mirroring girc's own
// newConn (TCP + optional TLS handshake, ServerName defaulting to the host)
// and then wrapping it in lineFilterConn. We hand the result to
// girc.MockConnect so girc skips its internal dial+TLS but still runs the full
// registration flow (PASS / CAP / NICK / USER). This is the only way to put a
// filter ABOVE TLS — a girc DialerConnect filter would see ciphertext.
func dial(ctx context.Context, cfg Config) (net.Conn, error) {
	addr := net.JoinHostPort(cfg.Hostname, strconv.Itoa(cfg.Port))
	d := &net.Dialer{Timeout: cfg.ConnTimeout}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}

	var conn net.Conn = raw
	if cfg.TLS {
		tc := tlsConfigFor(cfg)
		if tc == nil {
			tc = &tls.Config{ServerName: cfg.Hostname}
		} else if tc.ServerName == "" {
			tc.ServerName = cfg.Hostname
		}
		tlsConn := tls.Client(raw, tc)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = raw.Close()
			return nil, err
		}
		conn = tlsConn
	}

	return newLineFilterConn(conn), nil
}
