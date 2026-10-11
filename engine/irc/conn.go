package irc

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"log/slog"
	"net"
	"strconv"
	"sync"

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
//
// On the write side it drops the lines autoQueryFilter claims (girc's own
// per-channel WHOX + MODE on self-JOIN), which the engine re-sends through its
// paced queue instead.
type lineFilterConn struct {
	net.Conn
	r       *bufio.Reader
	pending []byte // bytes of the current accepted line still to be served

	wmu       sync.Mutex
	wbuf      []byte // a partial outbound line, held until its \n arrives
	dropWrite func(line []byte) bool
}

func newLineFilterConn(c net.Conn) *lineFilterConn {
	return &lineFilterConn{Conn: c, r: bufio.NewReader(c), dropWrite: newAutoQueryFilter().drop}
}

// Write passes whole lines through, minus the ones dropWrite claims. It
// reports every byte as written, dropped or not, so girc never retries.
func (l *lineFilterConn) Write(p []byte) (int, error) {
	if l.dropWrite == nil {
		return l.Conn.Write(p)
	}
	l.wmu.Lock()
	defer l.wmu.Unlock()
	l.wbuf = append(l.wbuf, p...)
	var out []byte
	for {
		i := bytes.IndexByte(l.wbuf, '\n')
		if i < 0 {
			break
		}
		line := l.wbuf[:i+1]
		if !l.dropWrite(line) {
			out = append(out, line...)
		}
		l.wbuf = l.wbuf[i+1:]
	}
	l.wbuf = append([]byte(nil), l.wbuf...)
	if len(out) > 0 {
		if _, err := l.Conn.Write(out); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

// autoQueryFilter recognises the two lines girc writes straight to the socket
// on every self-JOIN: `WHO #chan %tacuhnr,1` then `MODE #chan`. They bypass
// the send queue, so on a bouncer they landed in ZNC's FIFO flood queue (2s a
// line by default) ahead of whatever the user typed next: with twenty
// channels, a message sent after attaching took minutes to reach the network.
// The WHOX reply only fed girc's user tracking, which the engine doesn't read
// (it sends its own plain WHO for away flags), so it is dropped outright; the
// MODE is re-sent through the queue as background traffic. A bare MODE is only
// claimed right after its channel's WHOX, so user-issued MODE queries pass.
type autoQueryFilter struct {
	mu         sync.Mutex
	expectMode map[string]struct{}
}

func newAutoQueryFilter() *autoQueryFilter {
	return &autoQueryFilter{expectMode: map[string]struct{}{}}
}

func (f *autoQueryFilter) drop(line []byte) bool {
	if !bytes.HasPrefix(line, []byte("WHO ")) && !bytes.HasPrefix(line, []byte("MODE ")) {
		return false
	}
	ev := girc.ParseEvent(string(line))
	if ev == nil {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case ev.Command == girc.WHO && len(ev.Params) == 2 && ev.Params[1] == "%tacuhnr,1":
		f.expectMode[girc.ToRFC1459(ev.Params[0])] = struct{}{}
		return true
	case ev.Command == girc.MODE && len(ev.Params) == 1:
		key := girc.ToRFC1459(ev.Params[0])
		if _, ok := f.expectMode[key]; ok {
			delete(f.expectMode, key)
			return true
		}
	}
	return false
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
