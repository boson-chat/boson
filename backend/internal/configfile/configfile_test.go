package configfile

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestParseErrorsHaveLineAndColumn(t *testing.T) {
	cases := []struct {
		name, src  string
		line, col  int
		wantSubstr string
	}{
		{"syntax", "version: 1\nauth:\n  a: b\n  c\n", 4, 0, ""},
		{"not a mapping", "- a\n- b\n", 1, 1, "must be a mapping"},
		{"bad version", "version: 2\n", 1, 10, "version must be 1"},
		{"section not mapping", "version: 1\nauth: 3\n", 2, 7, "auth must be a mapping"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			doc, err := Parse([]byte(c.src))
			if err == nil {
				_, err = doc.Section("auth")
			}
			e, ok := AsError(err)
			if !ok {
				t.Fatalf("want *Error, got %v", err)
			}
			if e.Line != c.line || (c.col != 0 && e.Column != c.col) {
				t.Fatalf("position = %d:%d, want %d:%d (%v)", e.Line, e.Column, c.line, c.col, e)
			}
		})
	}
}

func TestSectionValues(t *testing.T) {
	src := `version: 1
auth:
  name: Boson
  on: true
  n: 7
  every: 10m
  list: [a, b]
  one: c
  nothing: ~
  nested: { host: h }
other: { x: 1 }
`
	doc, err := Parse([]byte(src))
	if err != nil {
		t.Fatal(err)
	}
	s, err := doc.Section("auth")
	if err != nil || s == nil {
		t.Fatal(s, err)
	}
	if v, _ := s.String("name"); v == nil || *v != "Boson" {
		t.Fatal("name", v)
	}
	if v, _ := s.Bool("on"); v == nil || !*v {
		t.Fatal("on")
	}
	if v, _ := s.Int("n"); v == nil || *v != 7 {
		t.Fatal("n")
	}
	if v, _ := s.Duration("every"); v == nil || *v != 10*time.Minute {
		t.Fatal("every")
	}
	if l, set, _ := s.Strings("list"); !set || len(l) != 2 {
		t.Fatal("list", l)
	}
	if l, set, _ := s.Strings("one"); !set || len(l) != 1 || l[0] != "c" {
		t.Fatal("one", l)
	}
	if s.Has("nothing") || s.Has("missing") {
		t.Fatal("null / missing keys are absent")
	}
	sub, err := s.Sub("nested")
	if err != nil || sub.Path() != "auth.nested" {
		t.Fatal(sub, err)
	}
	if u := s.Unknown("name", "on", "n", "every", "list", "one", "nested"); len(u) != 1 || u[0] != "auth.nothing" {
		t.Fatal(u)
	}
	// Absent section: every key absent, no panic.
	none, _ := doc.Section("missing")
	if none.Has("x") {
		t.Fatal("absent section")
	}
	if v, err := none.String("x"); v != nil || err != nil {
		t.Fatal(v, err)
	}
}

func TestSectionTypeErrors(t *testing.T) {
	doc, err := Parse([]byte("auth:\n  on: yes please\n  n: seven\n  l: {a: 1}\n  d: soon\n"))
	if err != nil {
		t.Fatal(err)
	}
	s, _ := doc.Section("auth")
	for key, line := range map[string]int{"on": 2, "n": 3, "l": 4, "d": 5} {
		var err error
		switch key {
		case "on":
			_, err = s.Bool(key)
		case "n":
			_, err = s.Int(key)
		case "l":
			_, _, err = s.Strings(key)
		case "d":
			_, err = s.Duration(key)
		}
		e, ok := AsError(err)
		if !ok || e.Line != line || e.Column != len(key)+5 {
			t.Fatalf("%s: %v", key, err)
		}
	}
}

func TestEmptyFileIsValid(t *testing.T) {
	for _, src := range []string{"", "# only a comment\n", "~\n"} {
		doc, err := Parse([]byte(src))
		if err != nil {
			t.Fatalf("%q: %v", src, err)
		}
		if s, err := doc.Section("auth"); s != nil || err != nil {
			t.Fatal(s, err)
		}
	}
}

func TestChangedKeys(t *testing.T) {
	got := ChangedKeys(map[string]any{"a": 1, "b": []string{"x"}, "c": true}, map[string]any{"a": 1, "b": []string{"y"}, "d": 2})
	want := []string{"b", "c", "d"}
	if len(got) != len(want) {
		t.Fatal(got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatal(got)
		}
	}
}

// ---- watcher ----

type testCfg struct{ Name string }

type recorder struct {
	mu      sync.Mutex
	changes []Change[testCfg]
	ch      chan Change[testCfg]
}

func (r *recorder) apply(_ context.Context, c Change[testCfg]) {
	r.mu.Lock()
	r.changes = append(r.changes, c)
	r.mu.Unlock()
	select {
	case r.ch <- c:
	default:
	}
}

func loadTest(doc *Document) (testCfg, error) {
	s, err := doc.Section("svc")
	if err != nil {
		return testCfg{}, err
	}
	name, err := s.String("name")
	if err != nil {
		return testCfg{}, err
	}
	c := testCfg{Name: "default"}
	if name != nil {
		if *name == "" {
			return testCfg{}, s.Errorf("name", "can't be empty")
		}
		c.Name = *name
	}
	return c, nil
}

func newTestWatcher(t *testing.T, path string, noNotify bool, poll time.Duration) (*Watcher[testCfg], *recorder) {
	t.Helper()
	r := &recorder{ch: make(chan Change[testCfg], 16)}
	w := New(Options[testCfg]{
		Path: path, Load: loadTest, Apply: r.apply, Poll: poll, Debounce: 20 * time.Millisecond, NoNotify: noNotify,
		RestartRequired: func(boot, cur State[testCfg]) []string {
			if boot.Value.Name != cur.Value.Name {
				return []string{"svc.name"}
			}
			return nil
		},
	})
	return w, r
}

// writeAtomic writes like the admin panel: tmp file in the same dir, then rename.
func writeAtomic(t *testing.T, path, content string) {
	t.Helper()
	tmp, err := os.CreateTemp(filepath.Dir(path), ".boson-*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tmp.WriteString(content); err != nil {
		t.Fatal(err)
	}
	_ = tmp.Sync()
	_ = tmp.Close()
	if err := os.Rename(tmp.Name(), path); err != nil {
		t.Fatal(err)
	}
}

func wait(t *testing.T, r *recorder, want string) Change[testCfg] {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case c := <-r.ch:
			if c.Next.Value.Name == want || (want == "" && !c.Next.Present) {
				return c
			}
		case <-deadline:
			t.Fatalf("no change to %q", want)
		}
	}
}

func TestWatcherLoadMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "boson.yaml")
	w, r := newTestWatcher(t, path, true, time.Hour)
	if err := w.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.Current().Present || len(r.changes) != 1 || !r.changes[0].Initial {
		t.Fatal(w.Current(), r.changes)
	}
	st := w.Status()
	if !st.OK || st.Present || !st.Enabled || st.FileMtime != nil {
		t.Fatalf("%+v", st)
	}
}

func TestWatcherLoadInvalidRunsOnEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), "boson.yaml")
	_ = os.WriteFile(path, []byte("svc:\n  name: \"\"\n"), 0o644)
	w, r := newTestWatcher(t, path, true, time.Hour)
	ctx := context.Background()
	if err := w.Load(ctx); err != nil {
		t.Fatal("an invalid file at start-up is reported, not fatal:", err)
	}
	if w.Current().Present || len(r.changes) != 1 || r.changes[0].Next.Present {
		t.Fatal("no last good config: env/database mode", w.Current())
	}
	st := w.Status()
	if st.OK || st.ErrorLine != 2 || st.LoadedAt != nil || st.FileMtime == nil {
		t.Fatalf("%+v", st)
	}
	// Fixed: applied live.
	writeAtomic(t, path, "svc:\n  name: fixed\n")
	w.Check(ctx)
	if !w.Current().Present || w.Current().Value.Name != "fixed" {
		t.Fatal(w.Current())
	}
	if st := w.Status(); !st.OK || st.LoadedAt == nil {
		t.Fatalf("%+v", st)
	}
}

func TestWatcherInvalidKeepsLastGood(t *testing.T) {
	path := filepath.Join(t.TempDir(), "boson.yaml")
	_ = os.WriteFile(path, []byte("version: 1\nsvc:\n  name: one\n"), 0o644)
	w, r := newTestWatcher(t, path, true, time.Hour)
	ctx := context.Background()
	if err := w.Load(ctx); err != nil {
		t.Fatal(err)
	}
	writeAtomic(t, path, "version: 1\nsvc:\n  name: [broken\n")
	w.Check(ctx)
	if w.Current().Value.Name != "one" {
		t.Fatal("last good config must stay", w.Current())
	}
	st := w.Status()
	if st.OK || st.Error == "" || st.ErrorLine == 0 {
		t.Fatalf("%+v", st)
	}
	if len(r.changes) != 1 {
		t.Fatal("invalid file must not apply", r.changes)
	}
	// Same broken content again: no new attempt is logged/applied.
	w.Check(ctx)
	// Fixed: applies, status ok again, restart_required reported.
	writeAtomic(t, path, "version: 1\nsvc:\n  name: two\n")
	w.Check(ctx)
	if w.Current().Value.Name != "two" {
		t.Fatal(w.Current())
	}
	st = w.Status()
	if !st.OK || st.Error != "" || len(st.RestartRequired) != 1 || st.RestartRequired[0] != "svc.name" {
		t.Fatalf("%+v", st)
	}
	if c := r.changes[len(r.changes)-1]; c.Prev.Value.Name != "one" || c.Initial {
		t.Fatalf("%+v", c)
	}
}

func TestWatcherUnchangedContentDoesNotApply(t *testing.T) {
	path := filepath.Join(t.TempDir(), "boson.yaml")
	_ = os.WriteFile(path, []byte("svc:\n  name: one\n"), 0o644)
	w, r := newTestWatcher(t, path, true, time.Hour)
	ctx := context.Background()
	_ = w.Load(ctx)
	writeAtomic(t, path, "svc:\n  name: one\n")
	w.Check(ctx)
	if len(r.changes) != 1 {
		t.Fatal(r.changes)
	}
}

func TestWatcherRemovedAndRecreated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "boson.yaml")
	_ = os.WriteFile(path, []byte("svc:\n  name: one\n"), 0o644)
	w, r := newTestWatcher(t, path, true, time.Hour)
	ctx := context.Background()
	_ = w.Load(ctx)
	_ = os.Remove(path)
	w.Check(ctx)
	if w.Current().Present {
		t.Fatal("removed file → env/database mode")
	}
	if c := r.changes[len(r.changes)-1]; c.Next.Present || !c.Prev.Present {
		t.Fatalf("%+v", c)
	}
	writeAtomic(t, path, "svc:\n  name: one\n")
	w.Check(ctx)
	if !w.Current().Present || len(r.changes) != 3 {
		t.Fatal(w.Current(), len(r.changes))
	}
}

func TestWatcherDetectsRenameReplace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "boson.yaml")
	_ = os.WriteFile(path, []byte("svc:\n  name: one\n"), 0o644)
	// Polling effectively off: only fsnotify on the directory can see it.
	w, r := newTestWatcher(t, path, false, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := w.Load(ctx); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	time.Sleep(100 * time.Millisecond) // watcher registered
	writeAtomic(t, path, "svc:\n  name: two\n")
	wait(t, r, "two")
	writeAtomic(t, path, "svc:\n  name: three\n")
	wait(t, r, "three")
	cancel()
	<-done
}

func TestWatcherPollFallback(t *testing.T) {
	path := filepath.Join(t.TempDir(), "boson.yaml")
	_ = os.WriteFile(path, []byte("svc:\n  name: one\n"), 0o644)
	w, r := newTestWatcher(t, path, true, 30*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = w.Load(ctx)
	go w.Run(ctx)
	// Different size so the change shows even on coarse-mtime file systems.
	writeAtomic(t, path, "svc:\n  name: polled\n")
	wait(t, r, "polled")
	_ = os.Remove(path)
	wait(t, r, "")
}

func TestStatusHandler(t *testing.T) {
	rec := httptest.NewRecorder()
	StatusHandler(nil).ServeHTTP(rec, httptest.NewRequest("GET", "/internal/config/status", nil))
	var st map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st["enabled"] != false || st["ok"] != true || st["restart_required"] == nil {
		t.Fatal(st)
	}
	path := filepath.Join(t.TempDir(), "boson.yaml")
	_ = os.WriteFile(path, []byte("svc:\n  name: one\n"), 0o644)
	w, _ := newTestWatcher(t, path, true, time.Hour)
	_ = w.Load(context.Background())
	rec = httptest.NewRecorder()
	StatusHandler(w.Status).ServeHTTP(rec, httptest.NewRequest("GET", "/internal/config/status", nil))
	st = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	for _, k := range []string{"loaded_at", "file_mtime", "ok", "restart_required"} {
		if _, ok := st[k]; !ok {
			t.Fatalf("missing %s: %v", k, st)
		}
	}
}

func TestFloatKeysAndKeyNode(t *testing.T) {
	doc, err := Parse([]byte("s:\n  a: 1\n  b: 0.5\n  c: x\n  d: ~\n"))
	if err != nil {
		t.Fatal(err)
	}
	s, _ := doc.Section("s")
	if v, err := s.Float("a"); err != nil || *v != 1 {
		t.Fatal(v, err)
	}
	if v, err := s.Float("b"); err != nil || *v != 0.5 {
		t.Fatal(v, err)
	}
	if _, err := s.Float("c"); err == nil {
		t.Fatal("string is not a number")
	}
	if v, err := s.Float("d"); v != nil || err != nil {
		t.Fatal("null is absent")
	}
	if got := s.Keys(); len(got) != 4 || got[0] != "a" || got[3] != "d" {
		t.Fatal(got)
	}
	if n := s.KeyNode("c"); n == nil || n.Line != 4 || n.Column != 3 {
		t.Fatal(n)
	}
	var nilSec *Section
	if nilSec.Keys() != nil || nilSec.KeyNode("a") != nil || s.KeyNode("zz") != nil {
		t.Fatal("absent")
	}
}
