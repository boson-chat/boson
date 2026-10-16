package main

import (
	"sync"
	"testing"
	"time"
)

type recordedEvent struct {
	name string
	data any
}

type eventLog struct {
	mu     sync.Mutex
	events []recordedEvent
}

func (l *eventLog) emit(name string, data any) {
	l.mu.Lock()
	l.events = append(l.events, recordedEvent{name, data})
	l.mu.Unlock()
}

// waitFor returns the first event matching ok, failing after 3s.
func (l *eventLog) waitFor(t *testing.T, what string, ok func(recordedEvent) bool) recordedEvent {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		for _, ev := range l.events {
			if ok(ev) {
				l.mu.Unlock()
				return ev
			}
		}
		l.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %s event", what)
	return recordedEvent{}
}

func TestEngineService_FramesCarryTheirSession(t *testing.T) {
	log := &eventLog{}
	e := &EngineService{emit: log.emit}
	defer e.Close()
	id := e.Open()
	if err := e.Send("{not json"); err != nil {
		t.Fatal(err)
	}
	ev := log.waitFor(t, "frame", func(ev recordedEvent) bool { return ev.name == EngineEvent })
	if f := ev.data.(engineFrame); f.Session != id || f.Frame == "" {
		t.Fatalf("frame %+v, want session %d", f, id)
	}
}

func TestEngineService_CrashClosesTheSession(t *testing.T) {
	log := &eventLog{}
	e := &EngineService{emit: log.emit}
	defer e.Close()
	if got := e.crash(); got != 0 {
		t.Fatalf("crash with nothing open = %d, want 0", got)
	}
	id := e.Open()
	if e.session() != id {
		t.Fatalf("session() = %d, want %d", e.session(), id)
	}
	if got := e.crash(); got != id {
		t.Fatalf("crash() = %d, want %d", got, id)
	}
	log.waitFor(t, "closed", func(ev recordedEvent) bool { return ev.name == EngineClosedEvent && ev.data == id })
	if e.session() != 0 {
		t.Fatal("a session is still open after the crash")
	}
	if err := e.Send("{}"); err == nil {
		t.Fatal("Send after a crash succeeded")
	}
	// The renderer reconnects: a new session, with a new id.
	if next := e.Open(); next == id {
		t.Fatalf("reopened session reused id %d", id)
	}
}

func TestEngineService_ReplacedSessionSaysItClosed(t *testing.T) {
	log := &eventLog{}
	e := &EngineService{emit: log.emit}
	defer e.Close()
	first := e.Open()
	e.Open()
	log.waitFor(t, "closed", func(ev recordedEvent) bool { return ev.name == EngineClosedEvent && ev.data == first })
}
