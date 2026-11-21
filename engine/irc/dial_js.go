//go:build js && wasm

package irc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"syscall/js"
)

// dialTransport in the browser: a WebSocket to the IRC gateway, which
// dials the network (and does its TLS). See gateway.go.
func dialTransport(ctx context.Context, cfg Config) (net.Conn, error) {
	url := currentGatewayURL()
	if url == "" {
		return nil, errors.New("no IRC gateway configured")
	}
	sock, err := openJSWebSocket(ctx, url, cfg.ConnTimeout)
	if err != nil {
		return nil, err
	}
	if err := sock.Send(gatewayHostLine(cfg)); err != nil {
		_ = sock.Close()
		return nil, err
	}
	return newGatewayConn(sock, url), nil
}

type jsWebSocket struct {
	ws js.Value
	in chan string
	// Messages from JS wait here in order (a JS handler must not block),
	// and pump moves them to in.
	qmu   sync.Mutex
	queue []string
	kick  chan struct{}
	// closed: we closed it; nobody reads in any more.
	closed    chan struct{}
	closeOnce sync.Once
	done      chan struct{}
	once      sync.Once
	mu        sync.Mutex
	err       error
	funcs     []js.Func
}

func openJSWebSocket(ctx context.Context, url string, timeout interface{ Seconds() float64 }) (*jsWebSocket, error) {
	ctor := js.Global().Get("WebSocket")
	if ctor.IsUndefined() {
		return nil, errors.New("WebSocket is not available")
	}
	s := &jsWebSocket{
		ws: ctor.New(url),
		// Generous: the engine reads continuously; a burst (a bouncer's
		// backlog) waits here rather than in the JS event queue.
		in:     make(chan string, 256),
		kick:   make(chan struct{}, 1),
		closed: make(chan struct{}),
		done:   make(chan struct{}),
	}
	go s.pump()
	opened := make(chan struct{})
	var openOnce sync.Once
	s.on("open", func(js.Value) { openOnce.Do(func() { close(opened) }) })
	s.on("message", func(ev js.Value) {
		data := ev.Get("data")
		if data.Type() != js.TypeString {
			return
		}
		s.qmu.Lock()
		s.queue = append(s.queue, data.String())
		s.qmu.Unlock()
		select {
		case s.kick <- struct{}{}:
		default:
		}
	})
	s.on("error", func(js.Value) { s.finish(errors.New("IRC gateway connection failed")) })
	s.on("close", func(ev js.Value) {
		code := ev.Get("code").Int()
		reason := ev.Get("reason").String()
		if code == 1000 || code == 1005 {
			s.finish(nil)
			return
		}
		if reason == "" {
			s.finish(fmt.Errorf("IRC gateway closed the connection (%d)", code))
		} else {
			s.finish(fmt.Errorf("IRC gateway: %s", reason))
		}
	})
	select {
	case <-opened:
		return s, nil
	case <-s.done:
		return nil, s.Err()
	case <-ctx.Done():
		_ = s.Close()
		return nil, ctx.Err()
	}
}

func (s *jsWebSocket) on(event string, fn func(js.Value)) {
	f := js.FuncOf(func(_ js.Value, args []js.Value) any {
		var ev js.Value
		if len(args) > 0 {
			ev = args[0]
		}
		fn(ev)
		return nil
	})
	s.funcs = append(s.funcs, f)
	s.ws.Call("addEventListener", event, f)
}

// pump delivers queued messages to in, in order; after the socket is done
// it delivers what's left and closes in (the reader then sees EOF).
func (s *jsWebSocket) pump() {
	defer close(s.in)
	for {
		s.qmu.Lock()
		q := s.queue
		s.queue = nil
		s.qmu.Unlock()
		for _, m := range q {
			select {
			case s.in <- m:
			case <-s.closed:
				return
			}
		}
		if len(q) > 0 {
			continue
		}
		select {
		case <-s.kick:
		case <-s.done:
			s.qmu.Lock()
			rest := s.queue
			s.queue = nil
			s.qmu.Unlock()
			for _, m := range rest {
				select {
				case s.in <- m:
				case <-s.closed:
					return
				}
			}
			return
		}
	}
}

func (s *jsWebSocket) finish(err error) {
	s.once.Do(func() {
		s.mu.Lock()
		if err == nil {
			err = errGatewayClosed
		}
		s.err = err
		s.mu.Unlock()
		close(s.done)
		// Messages already queued are still delivered; then EOF.
		go func() {
			for _, f := range s.funcs {
				f.Release()
			}
		}()
	})
}

func (s *jsWebSocket) Send(msg string) error {
	select {
	case <-s.done:
		return s.Err()
	default:
	}
	if s.ws.Get("readyState").Int() != 1 {
		return errGatewayClosed
	}
	s.ws.Call("send", msg)
	return nil
}

func (s *jsWebSocket) Messages() <-chan string { return s.in }
func (s *jsWebSocket) Done() <-chan struct{}   { return s.done }

func (s *jsWebSocket) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

func (s *jsWebSocket) Close() error {
	s.closeOnce.Do(func() { close(s.closed) })
	s.ws.Call("close", 1000)
	s.finish(nil)
	return nil
}
