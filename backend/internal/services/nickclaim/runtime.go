package nickclaim

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/boson-chat/boson/backend/internal/logger"
)

// Settings are the live nick-claim settings (stack config file, then
// env, then defaults), handed to Runtime.Apply on start-up and on every
// config reload.
type Settings struct {
	Enabled          bool
	EmailDomain      string
	RateLimitPerHour int
	// Inbound is the catch-all mailbox. Only POP3 is supported.
	Inbound WorkerConfig
	// ConfigError is set when the configured settings were rejected
	// (e.g. enabled without an inbound host); the feature then runs
	// disabled and the admin panel shows why.
	ConfigError string
}

// InboundStatus is the inbound config as shown to the admin panel (never
// the password).
type InboundStatus struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	TLS  bool   `json:"tls"`
	User string `json:"user"`
}

// Status is GET /internal/nick-claims/status.
type Status struct {
	Enabled       bool          `json:"enabled"`
	EmailDomain   string        `json:"email_domain"`
	Inbound       InboundStatus `json:"inbound"`
	Worker        WorkerHealth  `json:"worker"`
	PendingClaims int64         `json:"pending_claims"`
	ConfigError   string        `json:"config_error,omitempty"`
}

// Worker states in Summary.
const (
	WorkerStopped = "stopped"
	WorkerRunning = "running"
	WorkerError   = "error"
)

// Summary is the nick_claim block of GET /internal/config/status (no
// database read, no token).
type Summary struct {
	Enabled bool `json:"enabled"`
	// Worker: running (last drain fine), error (running but failing, or
	// enabled and unable to run) or stopped (disabled).
	Worker     string     `json:"worker"`
	LastPollAt *time.Time `json:"last_poll_at"`
	LastError  string     `json:"last_error,omitempty"`
}

// TestResult is POST /internal/nick-claims/test.
type TestResult struct {
	OK       bool   `json:"ok"`
	Message  string `json:"message"`
	Messages int    `json:"messages"`
}

// RuntimeImpl owns the feature's moving parts: the claims service's live
// config and the POP3 worker, started and stopped as settings change.
type RuntimeImpl interface {
	// Apply makes s live: enabling starts the worker, disabling stops it,
	// and a change to the inbound settings restarts it.
	Apply(ctx context.Context, s Settings)
	// Settings returns the settings in use.
	Settings() Settings
	// Status reports settings, worker health and the pending claim count.
	Status(ctx context.Context) (Status, error)
	// Summary is the short form for the config status endpoint.
	Summary() Summary
	// TestInbound tries connect + auth + STAT against cfg.
	TestInbound(ctx context.Context, cfg WorkerConfig) TestResult
	// Stop stops the worker (shutdown).
	Stop()
}

// WorkerRunner is what Runtime runs; *Worker in production, fakes in tests.
type WorkerRunner interface {
	Run(ctx context.Context)
	Health() WorkerHealth
}

const (
	testTimeout = 15 * time.Second
	stopWait    = 10 * time.Second
)

// Runtime implements RuntimeImpl.
type Runtime struct {
	claims ServiceImpl
	parent context.Context

	newWorker func(WorkerConfig) WorkerRunner
	probe     func(ctx context.Context, cfg WorkerConfig) (int, error)

	mu         sync.Mutex
	settings   Settings
	cur        WorkerRunner
	curCfg     WorkerConfig
	cancel     context.CancelFunc
	done       chan struct{}
	lastHealth WorkerHealth
}

// NewRuntime builds the runtime. parent is the server's context: workers
// run under it, so shutdown stops them.
func NewRuntime(parent context.Context, claims ServiceImpl, repo RepositoryImpl) *Runtime {
	return NewRuntimeWith(parent, claims,
		func(cfg WorkerConfig) WorkerRunner { return NewWorker(cfg, repo) },
		probePOP3)
}

// NewRuntimeWith is the test seam: newWorker builds workers and probe
// runs the connection test.
func NewRuntimeWith(parent context.Context, claims ServiceImpl,
	newWorker func(WorkerConfig) WorkerRunner,
	probe func(ctx context.Context, cfg WorkerConfig) (int, error),
) *Runtime {
	return &Runtime{claims: claims, parent: parent, newWorker: newWorker, probe: probe}
}

func (r *Runtime) Apply(ctx context.Context, s Settings) {
	log := logger.FromCtx(ctx)
	r.claims.Configure(Config{
		Enabled:          s.Enabled,
		EmailDomain:      s.EmailDomain,
		RateLimitPerHour: s.RateLimitPerHour,
	})

	r.mu.Lock()
	defer r.mu.Unlock()
	prevEnabled := r.settings.Enabled
	r.settings = s
	want := s.Enabled && s.Inbound.Host != ""
	switch {
	case !want:
		if r.cur != nil {
			log.Info().Msg("nickclaim: disabled; stopping the POP3 worker")
		}
		r.stopLocked()
	case r.cur != nil && sameInbound(r.curCfg, s.Inbound):
		// Running with the same mailbox: nothing to do.
	default:
		if r.cur != nil {
			log.Info().Msg("nickclaim: inbound settings changed; restarting the POP3 worker")
			r.stopLocked()
		} else if !prevEnabled {
			log.Info().Msg("nickclaim: enabled; starting the POP3 worker")
		}
		r.startLocked(s.Inbound)
	}
}

func sameInbound(a, b WorkerConfig) bool {
	return a.Host == b.Host && a.Port == b.Port && a.UseTLS == b.UseTLS &&
		a.User == b.User && a.Password == b.Password &&
		a.PollInterval == b.PollInterval && a.SweepInterval == b.SweepInterval
}

func (r *Runtime) startLocked(cfg WorkerConfig) {
	ctx, cancel := context.WithCancel(r.parent)
	w := r.newWorker(cfg)
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.Run(ctx)
	}()
	r.cur, r.curCfg, r.cancel, r.done = w, cfg, cancel, done
	r.lastHealth = WorkerHealth{}
}

// stopLocked cancels the worker and waits (bounded) for it to exit. A
// drain blocked on the network ends at its session deadline at worst.
func (r *Runtime) stopLocked() {
	if r.cur == nil {
		return
	}
	r.cancel()
	select {
	case <-r.done:
	case <-time.After(stopWait):
	}
	r.lastHealth = r.cur.Health()
	r.lastHealth.Running = false
	r.cur, r.cancel, r.done = nil, nil, nil
}

func (r *Runtime) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopLocked()
}

func (r *Runtime) Settings() Settings {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.settings
}

// snapshot returns the settings and the worker health, with the reason
// an enabled feature can't run filled in.
func (r *Runtime) snapshot() (Settings, WorkerHealth) {
	r.mu.Lock()
	s := r.settings
	health := r.lastHealth
	if r.cur != nil {
		health = r.cur.Health()
	}
	r.mu.Unlock()
	switch {
	case s.ConfigError != "" && health.LastError == "":
		health.LastError = s.ConfigError
	case s.Enabled && s.Inbound.Host == "" && health.LastError == "":
		health.LastError = "nick_claim.inbound.host is not set"
	}
	return s, health
}

func (r *Runtime) Summary() Summary {
	s, h := r.snapshot()
	state := WorkerStopped
	switch {
	case h.Running && h.ConsecutiveFailures == 0:
		state = WorkerRunning
	case h.Running, s.Enabled, s.ConfigError != "":
		state = WorkerError
	}
	out := Summary{Enabled: s.Enabled, Worker: state, LastPollAt: h.LastDrainAt}
	if state == WorkerError {
		out.LastError = h.LastError
	}
	return out
}

func (r *Runtime) Status(ctx context.Context) (Status, error) {
	s, health := r.snapshot()
	pending, err := r.claims.CountPending(ctx)
	if err != nil {
		return Status{}, err
	}
	return Status{
		Enabled:     s.Enabled,
		EmailDomain: s.EmailDomain,
		Inbound: InboundStatus{
			Host: s.Inbound.Host, Port: s.Inbound.Port, TLS: s.Inbound.UseTLS, User: s.Inbound.User,
		},
		Worker:        health,
		PendingClaims: pending,
		ConfigError:   s.ConfigError,
	}, nil
}

func (r *Runtime) TestInbound(ctx context.Context, cfg WorkerConfig) TestResult {
	if strings.TrimSpace(cfg.Host) == "" {
		return TestResult{Message: "No inbound host is set."}
	}
	if cfg.Port == 0 {
		cfg.Port = 995
	}
	ctx, cancel := context.WithTimeout(ctx, testTimeout)
	defer cancel()
	type result struct {
		n   int
		err error
	}
	ch := make(chan result, 1)
	go func() {
		n, err := r.probe(ctx, cfg)
		ch <- result{n, err}
	}()
	var res result
	select {
	case res = <-ch:
	case <-ctx.Done():
		res.err = fmt.Errorf("timed out after %s", testTimeout)
	}
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	if res.err != nil {
		return TestResult{Message: redact(res.err.Error(), cfg.Password)}
	}
	return TestResult{
		OK: true,
		Message: fmt.Sprintf("Connected to %s and signed in as %s; %d message(s) waiting. "+
			"Use a mailbox dedicated to nick claims: the worker deletes messages that match no claim.", addr, cfg.User, res.n),
		Messages: res.n,
	}
}

// ErrAuth wraps a sign-in failure from probePOP3.
var ErrAuth = errors.New("sign-in failed")

// probePOP3 is the real connection test: connect, USER/PASS, STAT, QUIT.
func probePOP3(_ context.Context, cfg WorkerConfig) (int, error) {
	conn, err := dialPOP3(cfg, testTimeout)
	if err != nil {
		return 0, fmt.Errorf("connect failed: %w", err)
	}
	defer func() { _ = conn.Quit() }()
	if err := conn.Auth(cfg.User, cfg.Password); err != nil {
		return 0, fmt.Errorf("%w: %v", ErrAuth, err)
	}
	n, _, err := conn.Stat()
	if err != nil {
		return 0, fmt.Errorf("STAT failed: %w", err)
	}
	return n, nil
}

// redact removes the password from a message (servers sometimes echo
// what they were sent).
func redact(msg, password string) string {
	if password != "" {
		msg = strings.ReplaceAll(msg, password, "********")
	}
	return msg
}
