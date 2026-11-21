//go:build !js

package irc

import (
	"context"
	"crypto/tls"
	"net"
	"strconv"
)

// dialTransport mirrors girc's own newConn: TCP + an optional TLS handshake,
// ServerName defaulting to the host.
func dialTransport(ctx context.Context, cfg Config) (net.Conn, error) {
	addr := net.JoinHostPort(cfg.Hostname, strconv.Itoa(cfg.Port))
	d := &net.Dialer{Timeout: cfg.ConnTimeout}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	if !cfg.TLS {
		return raw, nil
	}
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
	return tlsConn, nil
}
