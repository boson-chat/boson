package nickclaim

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---- fakes ----------------------------------------------------------

type fakeClaims struct {
	mu      sync.Mutex
	cfg     Config
	pending int64
}

func (f *fakeClaims) Enabled() bool { return f.CurrentConfig().Enabled }
func (f *fakeClaims) Configure(c Config) {
	f.mu.Lock()
	f.cfg = c
	f.mu.Unlock()
}
func (f *fakeClaims) CurrentConfig() Config {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cfg
}
func (f *fakeClaims) CountPending(context.Context) (int64, error) { return f.pending, nil }
func (f *fakeClaims) CreateClaim(context.Context, uuid.UUID, string, string) (*NickClaim, error) {
	return nil, errors.New("unused")
}
func (f *fakeClaims) GetClaim(context.Context, uuid.UUID, uuid.UUID) (*NickClaim, error) {
	return nil, errors.New("unused")
}
func (f *fakeClaims) ConsumeIfCaptured(context.Context, uuid.UUID, uuid.UUID) (*NickClaim, error) {
	return nil, errors.New("unused")
}
func (f *fakeClaims) EmailFor(*NickClaim) string { return "" }

type fakeWorker struct {
	cfg     WorkerConfig
	running atomic.Bool
	stopped chan struct{}
}

func (w *fakeWorker) Run(ctx context.Context) {
	w.running.Store(true)
	<-ctx.Done()
	w.running.Store(false)
	close(w.stopped)
}

func (w *fakeWorker) Health() WorkerHealth {
	return WorkerHealth{Running: w.running.Load(), LastError: "fake " + w.cfg.Host}
}

type workerLog struct {
	mu      sync.Mutex
	started []*fakeWorker
}

func (l *workerLog) new(cfg WorkerConfig) WorkerRunner {
	w := &fakeWorker{cfg: cfg, stopped: make(chan struct{})}
	l.mu.Lock()
	l.started = append(l.started, w)
	l.mu.Unlock()
	return w
}

func (l *workerLog) all() []*fakeWorker {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]*fakeWorker(nil), l.started...)
}

func newTestRuntime(t *testing.T) (*Runtime, *fakeClaims, *workerLog) {
	t.Helper()
	claims := &fakeClaims{}
	wl := &workerLog{}
	rt := NewRuntimeWith(context.Background(), claims, wl.new, func(context.Context, WorkerConfig) (int, error) { return 0, nil })
	t.Cleanup(rt.Stop)
	return rt, claims, wl
}

func waitRunning(t *testing.T, w *fakeWorker) {
	t.Helper()
	require.Eventually(t, w.running.Load, 2*time.Second, 5*time.Millisecond)
}

var inboundA = WorkerConfig{Host: "a.example.com", Port: 995, UseTLS: true, User: "reg@a", Password: "pw"}

// ---- runtime --------------------------------------------------------

func TestRuntime_DisabledRunsNoWorker(t *testing.T) {
	rt, claims, wl := newTestRuntime(t)
	rt.Apply(context.Background(), Settings{Enabled: false, Inbound: inboundA})
	assert.Empty(t, wl.all())
	assert.False(t, claims.Enabled())

	st, err := rt.Status(context.Background())
	require.NoError(t, err)
	assert.False(t, st.Enabled)
	assert.False(t, st.Worker.Running)
}

func TestRuntime_EnableStartsDisableStops(t *testing.T) {
	rt, claims, wl := newTestRuntime(t)
	ctx := context.Background()
	rt.Apply(ctx, Settings{Enabled: true, EmailDomain: "example.com", RateLimitPerHour: 3, Inbound: inboundA})
	require.Len(t, wl.all(), 1)
	w := wl.all()[0]
	waitRunning(t, w)
	assert.Equal(t, Config{Enabled: true, EmailDomain: "example.com", RateLimitPerHour: 3}, claims.CurrentConfig())

	st, err := rt.Status(ctx)
	require.NoError(t, err)
	assert.True(t, st.Worker.Running)
	assert.Equal(t, InboundStatus{Host: "a.example.com", Port: 995, TLS: true, User: "reg@a"}, st.Inbound)

	// Same settings again (unrelated reload): the worker keeps running.
	rt.Apply(ctx, Settings{Enabled: true, EmailDomain: "example.com", RateLimitPerHour: 9, Inbound: inboundA})
	assert.Len(t, wl.all(), 1)
	assert.Equal(t, 9, claims.CurrentConfig().RateLimitPerHour)

	rt.Apply(ctx, Settings{Enabled: false, Inbound: inboundA})
	select {
	case <-w.stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("worker not stopped")
	}
	assert.False(t, claims.Enabled())
	st, err = rt.Status(ctx)
	require.NoError(t, err)
	assert.False(t, st.Worker.Running)
	assert.Equal(t, "fake a.example.com", st.Worker.LastError, "last health is kept after a stop")
}

func TestRuntime_InboundChangeRestarts(t *testing.T) {
	rt, _, wl := newTestRuntime(t)
	ctx := context.Background()
	rt.Apply(ctx, Settings{Enabled: true, EmailDomain: "example.com", Inbound: inboundA})
	first := wl.all()[0]
	waitRunning(t, first)

	b := inboundA
	b.Password = "rotated"
	rt.Apply(ctx, Settings{Enabled: true, EmailDomain: "example.com", Inbound: b})
	all := wl.all()
	require.Len(t, all, 2)
	<-first.stopped
	waitRunning(t, all[1])
	assert.Equal(t, "rotated", all[1].cfg.Password)
}

func TestRuntime_EnabledWithoutHost(t *testing.T) {
	rt, _, wl := newTestRuntime(t)
	rt.Apply(context.Background(), Settings{Enabled: true, EmailDomain: "example.com"})
	assert.Empty(t, wl.all())
	st, err := rt.Status(context.Background())
	require.NoError(t, err)
	assert.True(t, st.Enabled)
	assert.Contains(t, st.Worker.LastError, "inbound.host is not set")
}

func TestRuntime_StatusReportsPendingAndConfigError(t *testing.T) {
	rt, claims, _ := newTestRuntime(t)
	claims.pending = 4
	rt.Apply(context.Background(), Settings{ConfigError: "nick_claim is enabled but …"})
	st, err := rt.Status(context.Background())
	require.NoError(t, err)
	assert.EqualValues(t, 4, st.PendingClaims)
	assert.Equal(t, "nick_claim is enabled but …", st.ConfigError)
}

func TestRuntime_TestInbound(t *testing.T) {
	claims := &fakeClaims{}
	var got WorkerConfig
	probe := func(_ context.Context, cfg WorkerConfig) (int, error) {
		got = cfg
		if cfg.Password == "wrong" {
			return 0, fmt.Errorf("%w: -ERR bad password wrong", ErrAuth)
		}
		return 3, nil
	}
	rt := NewRuntimeWith(context.Background(), claims, (&workerLog{}).new, probe)

	res := rt.TestInbound(context.Background(), WorkerConfig{})
	assert.False(t, res.OK)
	assert.Contains(t, res.Message, "No inbound host")

	res = rt.TestInbound(context.Background(), WorkerConfig{Host: "h", User: "u", Password: "pw"})
	assert.True(t, res.OK)
	assert.Equal(t, 3, res.Messages)
	assert.Equal(t, 995, got.Port, "port defaults to 995")
	assert.Contains(t, res.Message, "signed in as u")
	assert.NotContains(t, res.Message, "pw")

	res = rt.TestInbound(context.Background(), WorkerConfig{Host: "h", Port: 110, User: "u", Password: "wrong"})
	assert.False(t, res.OK)
	assert.Contains(t, res.Message, "sign-in failed")
	assert.NotContains(t, res.Message, "wrong", "the password is redacted even when the server echoes it")
}

func TestRuntime_TestInboundHonoursContext(t *testing.T) {
	block := make(chan struct{})
	defer close(block)
	rt := NewRuntimeWith(context.Background(), &fakeClaims{}, (&workerLog{}).new,
		func(context.Context, WorkerConfig) (int, error) { <-block; return 0, nil })
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	res := rt.TestInbound(ctx, WorkerConfig{Host: "h"})
	assert.False(t, res.OK)
	assert.Contains(t, res.Message, "timed out")
}

// ---- worker health + backoff ---------------------------------------

func TestNextDelay(t *testing.T) {
	p := 5 * time.Second
	assert.Equal(t, p, nextDelay(p, 0))
	assert.Equal(t, p, nextDelay(p, 1), "a transient failure retries at the normal cadence")
	assert.Equal(t, p, nextDelay(p, backoffAfter-1))
	assert.Equal(t, 2*p, nextDelay(p, backoffAfter))
	assert.Equal(t, 4*p, nextDelay(p, backoffAfter+1))
	assert.Equal(t, maxBackoff, nextDelay(p, 50))
}

func TestWorkerRecord(t *testing.T) {
	w := NewWorker(WorkerConfig{Host: "h"}, nil)
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	w.now = func() time.Time { return now }
	assert.Equal(t, 1, w.record(errors.New("tls: first record does not look like a TLS handshake")))
	assert.Equal(t, 2, w.record(errors.New("again")))
	h := w.Health()
	assert.Equal(t, 2, h.ConsecutiveFailures)
	assert.Equal(t, "again", h.LastError)
	assert.Nil(t, h.LastOKAt)
	require.NotNil(t, h.LastDrainAt)

	assert.Equal(t, 0, w.record(nil))
	h = w.Health()
	assert.Zero(t, h.ConsecutiveFailures)
	assert.Empty(t, h.LastError)
	require.NotNil(t, h.LastOKAt)
	assert.Equal(t, now, *h.LastOKAt)
}

// ---- against a real (in-test) POP3 server ---------------------------

// pop3Server is a minimal POP3 server: USER/PASS (accepting user/pass),
// STAT, UIDL, QUIT.
type pop3Server struct {
	ln       net.Listener
	user     string
	pass     string
	messages int
	garbage  bool // answer like a non-POP3 service
}

func startPOP3(t *testing.T, s *pop3Server) (string, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	s.ln = ln
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	host, port, _ := net.SplitHostPort(ln.Addr().String())
	p, _ := strconv.Atoi(port)
	return host, p
}

func (s *pop3Server) serve(c net.Conn) {
	defer c.Close()
	if s.garbage {
		_, _ = c.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n"))
		return
	}
	w := func(line string) { _, _ = c.Write([]byte(line + "\r\n")) }
	w("+OK test pop3")
	r := bufio.NewReader(c)
	var user string
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) == 0 {
			continue
		}
		switch strings.ToUpper(f[0]) {
		case "USER":
			user = strings.Join(f[1:], " ")
			w("+OK")
		case "PASS":
			if user == s.user && strings.Join(f[1:], " ") == s.pass {
				w("+OK logged in")
			} else {
				w("-ERR invalid login")
			}
		case "NOOP":
			w("+OK")
		case "STAT":
			w(fmt.Sprintf("+OK %d %d", s.messages, s.messages*100))
		case "UIDL":
			w("+OK")
			w(".")
		case "QUIT":
			w("+OK bye")
			return
		default:
			w("-ERR unknown")
		}
	}
}

func TestProbePOP3_RealServer(t *testing.T) {
	host, port := startPOP3(t, &pop3Server{user: "reg@example.com", pass: "s3cret", messages: 2})
	rt := NewRuntime(context.Background(), &fakeClaims{}, nil)

	res := rt.TestInbound(context.Background(), WorkerConfig{Host: host, Port: port, User: "reg@example.com", Password: "s3cret"})
	assert.True(t, res.OK, res.Message)
	assert.Equal(t, 2, res.Messages)

	res = rt.TestInbound(context.Background(), WorkerConfig{Host: host, Port: port, User: "reg@example.com", Password: "nope"})
	assert.False(t, res.OK)
	assert.Contains(t, res.Message, "sign-in failed")
	assert.NotContains(t, res.Message, "nope")

	// TLS against a plaintext server: the production-style transient error.
	res = rt.TestInbound(context.Background(), WorkerConfig{Host: host, Port: port, UseTLS: true, User: "reg@example.com", Password: "s3cret"})
	assert.False(t, res.OK)
	assert.Contains(t, res.Message, "connect failed")
}

func TestWorker_RunRecordsHealthAgainstRealServer(t *testing.T) {
	good := &pop3Server{user: "u", pass: "p"}
	host, port := startPOP3(t, good)
	w := NewWorker(WorkerConfig{Host: host, Port: port, User: "u", Password: "p", PollInterval: 20 * time.Millisecond, SweepInterval: time.Hour}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	require.Eventually(t, func() bool { return w.Health().LastOKAt != nil }, 2*time.Second, 10*time.Millisecond)
	assert.True(t, w.Health().Running)
	cancel()
	<-done
	assert.False(t, w.Health().Running)

	bad := &pop3Server{garbage: true}
	host, port = startPOP3(t, bad)
	w = NewWorker(WorkerConfig{Host: host, Port: port, User: "u", Password: "p", PollInterval: 10 * time.Millisecond, SweepInterval: time.Hour}, nil)
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)
	require.Eventually(t, func() bool { return w.Health().ConsecutiveFailures >= backoffAfter }, 2*time.Second, 5*time.Millisecond)
	h := w.Health()
	assert.NotEmpty(t, h.LastError)
	assert.Nil(t, h.LastOKAt)
}

func TestRuntime_RealWorkerLifecycle(t *testing.T) {
	host, port := startPOP3(t, &pop3Server{user: "u", pass: "p"})
	claims := &fakeClaims{}
	rt := NewRuntime(context.Background(), claims, nil)
	defer rt.Stop()
	ctx := context.Background()
	in := WorkerConfig{Host: host, Port: port, User: "u", Password: "p", PollInterval: 20 * time.Millisecond, SweepInterval: time.Hour}
	rt.Apply(ctx, Settings{Enabled: true, EmailDomain: "example.com", Inbound: in})
	require.Eventually(t, func() bool {
		st, _ := rt.Status(ctx)
		return st.Worker.Running && st.Worker.LastOKAt != nil
	}, 2*time.Second, 10*time.Millisecond)
	rt.Apply(ctx, Settings{Enabled: false, Inbound: in})
	st, err := rt.Status(ctx)
	require.NoError(t, err)
	assert.False(t, st.Worker.Running)
	assert.NotNil(t, st.Worker.LastOKAt)
}

func TestRuntime_Summary(t *testing.T) {
	rt, _, wl := newTestRuntime(t)
	ctx := context.Background()
	assert.Equal(t, Summary{Worker: WorkerStopped}, rt.Summary())

	rt.Apply(ctx, Settings{Enabled: true, EmailDomain: "example.com"}) // no host
	s := rt.Summary()
	assert.Equal(t, WorkerError, s.Worker)
	assert.Contains(t, s.LastError, "inbound.host")

	rt.Apply(ctx, Settings{ConfigError: "bad file"})
	assert.Equal(t, Summary{Worker: WorkerError, LastError: "bad file"}, rt.Summary())

	rt.Apply(ctx, Settings{Enabled: true, EmailDomain: "example.com", Inbound: inboundA})
	waitRunning(t, wl.all()[0])
	// The fake reports a LastError but no failures: running.
	assert.Equal(t, WorkerRunning, rt.Summary().Worker)
	assert.True(t, rt.Summary().Enabled)
}
