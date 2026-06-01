//go:build e2e

// Package services_e2e drives real NickServ flows against a live IRC
// services stack (Anope, Atheme, or Ergo running in a docker compose
// profile) and captures every reply we receive. The captured replies
// are written out as JSON fixtures consumed by the renderer's
// classifier tests (client/src/renderer/src/modules/chat/services.fixtures.test.ts).
//
// Two layers of coverage:
//
//   1. The Go side proves a real services package actually responds
//      with the strings we think it does — catching upstream
//      phrasing changes the moment they ship.
//   2. The TS side replays those captured strings through
//      `classifyNickServReply` so the pattern table is verified
//      against ground-truth output, not human-typed approximations.
//
// Build-tagged `e2e` so default `go test ./...` skips this entirely.
// Run via `make test-e2e-ergo` (and friends), which starts the docker
// profile, waits for the IRCd to accept TCP, then invokes
// `go test -tags=e2e ./engine/internal/services_e2e/<stack>/...`.
package services_e2e

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boson-chat/boson/engine/irc"
)

// CapturedEvent is one line of NickServ chatter (or relevant numeric)
// we record while a scenario runs. JSON-friendly so the renderer can
// load it as a fixture.
type CapturedEvent struct {
	Kind    string            `json:"kind"`    // "NOTICE", "PRIVMSG", "900", etc.
	From    string            `json:"from"`    // sender nick or server hostname
	Target  string            `json:"target"`  // our nick
	Message string            `json:"message"` // trailing payload
	Args    []string          `json:"args,omitempty"`
	Tags    map[string]string `json:"tags,omitempty"`
}

// ScenarioFixture is what gets serialised to fixtures/<stack>/<name>.json.
// `Stack` is the services package being exercised; `Scenario` is the
// flow being tested (e.g. "register-no-confirm", "identify-success").
// `Events` is the ordered stream of NickServ replies we received.
type ScenarioFixture struct {
	Stack     string          `json:"stack"`    // "ergo" | "anope" | "atheme"
	Scenario  string          `json:"scenario"` // human label
	Recorded  time.Time       `json:"recorded"`
	IRCdLabel string          `json:"ircdLabel,omitempty"` // e.g. "ergo-2.13"
	Events    []CapturedEvent `json:"events"`
}

// Recorder is a thread-safe collector for NickServ replies + selected
// numerics relevant to the account flow (RPL_LOGGEDIN 900, etc).
// Filters out unrelated server traffic so the captured fixtures stay
// focused on what the classifier actually cares about.
type Recorder struct {
	mu      sync.Mutex
	events  []CapturedEvent
	myNick  string
}

func NewRecorder(myNick string) *Recorder {
	return &Recorder{myNick: myNick}
}

func (r *Recorder) Handle(e irc.Event) {
	if !r.isRelevant(e) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, CapturedEvent{
		Kind:    e.Kind,
		From:    e.From,
		Target:  e.Target,
		Message: e.Message,
		Args:    append([]string(nil), e.Args...),
		Tags:    copyTags(e.Tags),
	})
}

// Snapshot returns a copy of the events recorded so far. Used by
// scenario steps that need to wait for a specific reply before
// proceeding (see WaitForMatch).
func (r *Recorder) Snapshot() []CapturedEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]CapturedEvent, len(r.events))
	copy(out, r.events)
	return out
}

// WaitForMatch blocks until an event matching `predicate` is recorded
// or `timeout` elapses. Returns the matching event on success, or
// (zero, false) on timeout. Polls the snapshot at 100ms intervals —
// faster than the server's typical reply latency but slow enough that
// we don't burn CPU.
func (r *Recorder) WaitForMatch(timeout time.Duration, predicate func(CapturedEvent) bool) (CapturedEvent, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, e := range r.Snapshot() {
			if predicate(e) {
				return e, true
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return CapturedEvent{}, false
}

// isRelevant keeps the fixtures focused on what classifies. A real
// session produces hundreds of frames the classifier doesn't care
// about (PING, MODE, JOIN, RPL_NAMREPLY, etc.) — those would just
// noise the fixtures.
func (r *Recorder) isRelevant(e irc.Event) bool {
	switch e.Kind {
	// IRCv3 SASL / account-binding numerics — strong identification signals.
	case "900", "901", "902", "903", "904", "905", "906", "907", "908":
		return true
	}
	if e.Kind != "NOTICE" && e.Kind != "PRIVMSG" {
		return false
	}
	// Only NickServ traffic. Other service NOTICE-noise (ChanServ,
	// HostServ ad banners, etc.) isn't part of the account flow.
	from := strings.ToLower(e.From)
	return from == "nickserv"
}

// WriteFixture serialises the recorded events to
// fixtures/<stack>/<scenario>.json relative to the engine package.
// Pretty-printed so diffs are reviewable on PRs.
func WriteFixture(t *testing.T, stack, scenario, ircdLabel string, events []CapturedEvent) {
	t.Helper()
	fx := ScenarioFixture{
		Stack:     stack,
		Scenario:  scenario,
		Recorded:  time.Now().UTC(),
		IRCdLabel: ircdLabel,
		Events:    events,
	}
	body, err := json.MarshalIndent(fx, "", "  ")
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	dir := filepath.Join(fixtureRoot(t), stack)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir fixture dir: %v", err)
	}
	path := filepath.Join(dir, scenario+".json")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	t.Logf("fixture written: %s (%d events)", path, len(events))
}

// fixtureRoot resolves to engine/internal/services_e2e/fixtures. The
// test working directory is the package being tested (e.g.
// services_e2e/ergo), so we walk up to find the parent fixtures dir.
// Falls back to a path relative to the test binary if `..` isn't
// reachable for some reason.
func fixtureRoot(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	// services_e2e/<stack> → services_e2e/fixtures
	parent := filepath.Dir(cwd)
	candidate := filepath.Join(parent, "fixtures")
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	return filepath.Join(cwd, "fixtures")
}

// ConnectAndWait is the standard preamble for a scenario: build the
// client, wire up the recorder, dial, and return once RPL_WELCOME
// lands. The caller drives the actual NickServ flow afterwards.
//
// Returns the connected client, the recorder, and a teardown that
// quits the session + drains the background connect goroutine.
//
// Times out after 30s on the connect → welcome handshake. A healthy
// local docker stack lands welcome in well under a second.
func ConnectAndWait(t *testing.T, cfg irc.Config) (*irc.Client, *Recorder, func()) {
	t.Helper()
	client, err := irc.New(cfg)
	if err != nil {
		t.Fatalf("irc.New: %v", err)
	}
	rec := NewRecorder(cfg.Nick)

	welcomed := make(chan struct{}, 1)
	client.OnEvent(func(e irc.Event) {
		rec.Handle(e)
		if e.Kind == "001" {
			select {
			case welcomed <- struct{}{}:
			default:
			}
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	connErrCh := make(chan error, 1)
	go func() { connErrCh <- client.Connect(ctx) }()

	select {
	case <-welcomed:
		// good — proceed
	case err := <-connErrCh:
		cancel()
		t.Fatalf("connect: %v", err)
	case <-time.After(30 * time.Second):
		cancel()
		t.Fatalf("timeout waiting for welcome (001)")
	}

	teardown := func() {
		client.Quit("e2e teardown")
		cancel()
		// Drain the connect goroutine briefly so the test process exits cleanly.
		select {
		case <-connErrCh:
		case <-time.After(2 * time.Second):
		}
	}
	return client, rec, teardown
}

// NickservMsg sends `PRIVMSG NickServ :<body>` via the engine client's
// Privmsg method — the same path the renderer uses through
// chat.input(/msg NickServ ...) → ChatService.send → session.privmsg.
func NickservMsg(t *testing.T, client *irc.Client, body string) {
	t.Helper()
	client.Privmsg("NickServ", body)
}

func copyTags(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
