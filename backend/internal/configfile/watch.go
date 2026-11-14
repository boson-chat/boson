package configfile

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io/fs"
	nethttp "net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/rs/zerolog"
)

// Defaults for Options.
const (
	DefaultPoll     = 10 * time.Second
	DefaultDebounce = 250 * time.Millisecond
)

// State is the service's config at one point: Present is false when the
// file does not exist (the service then runs on env values and its
// database, exactly as without BOSON_CONFIG).
type State[T any] struct {
	Present bool
	Value   T
}

// Change is passed to Options.Apply.
type Change[T any] struct {
	Prev, Next State[T]
	// Initial is the load at start-up (Prev is the zero State).
	Initial bool
}

// Options configure a Watcher.
type Options[T any] struct {
	// Path is the file (BOSON_CONFIG).
	Path string
	// Load decodes and validates the service's section. Errors should be
	// *Error (line/column) where possible.
	Load func(doc *Document) (T, error)
	// Apply makes a new valid state live. It runs on the watcher goroutine,
	// one call at a time.
	Apply func(ctx context.Context, c Change[T])
	// RestartRequired lists the keys whose value differs between the state
	// the process started with and cur but only take effect after a
	// restart. Nil: everything applies live.
	RestartRequired func(boot, cur State[T]) []string
	// Poll is the mtime/size check interval (fallback for file systems
	// without change events). Default 10s.
	Poll time.Duration
	// Debounce delays a reload after a change event so a burst of events
	// (write + chmod + rename) loads once. Default 250ms.
	Debounce time.Duration
	// NoNotify turns fsnotify off (polling only; tests).
	NoNotify bool
	Log      *zerolog.Logger
	Now      func() time.Time
}

// Status is GET /internal/config/status.
type Status struct {
	// Enabled: BOSON_CONFIG is set.
	Enabled bool   `json:"enabled"`
	Path    string `json:"path,omitempty"`
	// Present: the file exists (false: env/database mode).
	Present bool `json:"present"`
	// LoadedAt is when the config in use was loaded; null while the file
	// has been invalid since start-up (running on env values).
	LoadedAt *time.Time `json:"loaded_at"`
	// FileMtime is the file's modification time at the last check (null
	// when the file is missing).
	FileMtime *time.Time `json:"file_mtime"`
	// OK is false when the file on disk is invalid; the last good config
	// stays in use and Error says why.
	OK          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
	ErrorLine   int    `json:"error_line,omitempty"`
	ErrorColumn int    `json:"error_column,omitempty"`
	// RestartRequired lists keys changed since start that need a restart.
	RestartRequired []string `json:"restart_required"`
}

// Watcher holds the current config and reloads it when the file changes.
type Watcher[T any] struct {
	o Options[T]

	mu       sync.Mutex // guards everything below; applyMu serialises Apply
	applyMu  sync.Mutex
	cur      State[T]
	boot     State[T]
	loadedAt time.Time
	loaded   bool
	mtime    time.Time
	size     int64
	exists   bool
	hash     [32]byte // content last attempted (good or bad)
	tried    bool
	err      error
}

// New returns a watcher for o.Path. Call Load, then Run.
func New[T any](o Options[T]) *Watcher[T] {
	if o.Poll <= 0 {
		o.Poll = DefaultPoll
	}
	if o.Debounce <= 0 {
		o.Debounce = DefaultDebounce
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		l := zerolog.Nop()
		o.Log = &l
	}
	return &Watcher[T]{o: o}
}

// Load reads the file once at start-up and applies it (Change.Initial).
// A missing file is not an error (env/database mode). Neither is an invalid
// one: with no last good config the service runs on env/database values,
// Status reports the error with loaded_at null, and the next valid version
// of the file is applied live. Only an unreadable path is an error.
func (w *Watcher[T]) Load(ctx context.Context) error {
	data, info, err := w.read()
	w.applyMu.Lock()
	defer w.applyMu.Unlock()
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			w.mu.Lock()
			w.exists, w.loaded, w.loadedAt = false, true, w.o.Now()
			w.mu.Unlock()
			w.o.Log.Info().Str("path", w.o.Path).Msg("config file not found; using env values and the database")
			w.o.Apply(ctx, Change[T]{Next: State[T]{}, Initial: true})
			return nil
		}
		return err
	}
	v, perr := w.parse(data)
	w.mu.Lock()
	w.exists, w.mtime, w.size = true, info.ModTime(), info.Size()
	w.hash, w.tried = sha256.Sum256(data), true
	w.mu.Unlock()
	if perr != nil {
		w.mu.Lock()
		w.err = perr
		w.mu.Unlock()
		w.o.Log.Error().Str("path", w.o.Path).Str("error", perr.Error()).
			Msg("config file invalid at start-up; using env values and the database until it is fixed")
		w.o.Apply(ctx, Change[T]{Next: State[T]{}, Initial: true})
		return nil
	}
	next := State[T]{Present: true, Value: v}
	w.mu.Lock()
	w.cur, w.boot, w.loaded, w.loadedAt, w.err = next, next, true, w.o.Now(), nil
	w.mu.Unlock()
	w.o.Log.Info().Str("path", w.o.Path).Msg("config loaded")
	w.o.Apply(ctx, Change[T]{Next: next, Initial: true})
	return nil
}

func (w *Watcher[T]) read() ([]byte, fs.FileInfo, error) {
	info, err := os.Stat(w.o.Path)
	if err != nil {
		return nil, nil, err
	}
	if info.IsDir() {
		return nil, nil, errors.New(w.o.Path + " is a directory")
	}
	data, err := os.ReadFile(w.o.Path)
	return data, info, err
}

func (w *Watcher[T]) parse(data []byte) (T, error) {
	var zero T
	doc, err := Parse(data)
	if err != nil {
		return zero, err
	}
	return w.o.Load(doc)
}

// Current returns the config in use.
func (w *Watcher[T]) Current() State[T] {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.cur
}

// Status reports the watcher's state.
func (w *Watcher[T]) Status() Status {
	w.mu.Lock()
	defer w.mu.Unlock()
	st := Status{Enabled: true, Path: w.o.Path, Present: w.cur.Present, OK: w.err == nil, RestartRequired: []string{}}
	if w.loaded {
		t := w.loadedAt.UTC()
		st.LoadedAt = &t
	}
	if w.exists {
		t := w.mtime.UTC()
		st.FileMtime = &t
	}
	if w.err != nil {
		st.Error = w.err.Error()
		if e, ok := AsError(w.err); ok {
			st.ErrorLine, st.ErrorColumn = e.Line, e.Column
		}
	}
	if w.o.RestartRequired != nil {
		if keys := w.o.RestartRequired(w.boot, w.cur); len(keys) > 0 {
			st.RestartRequired = keys
		}
	}
	return st
}

// Check looks at the file now and reloads it when its content changed.
func (w *Watcher[T]) Check(ctx context.Context) {
	w.applyMu.Lock()
	defer w.applyMu.Unlock()
	log := w.o.Log
	data, info, err := w.read()
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			w.mu.Lock()
			w.err = err
			w.mu.Unlock()
			log.Error().Err(err).Str("path", w.o.Path).Msg("config file unreadable; keeping the last good config")
			return
		}
		w.mu.Lock()
		was := w.cur
		gone := w.exists || w.cur.Present
		w.exists, w.tried, w.err = false, false, nil
		if gone {
			w.cur, w.loadedAt = State[T]{}, w.o.Now()
		}
		w.mu.Unlock()
		if gone {
			log.Warn().Str("path", w.o.Path).Msg("config file removed; using env values and the database")
			w.o.Apply(ctx, Change[T]{Prev: was, Next: State[T]{}})
		}
		return
	}
	sum := sha256.Sum256(data)
	w.mu.Lock()
	w.exists, w.mtime, w.size = true, info.ModTime(), info.Size()
	same := w.tried && bytes.Equal(sum[:], w.hash[:])
	w.hash, w.tried = sum, true
	w.mu.Unlock()
	if same {
		return
	}
	v, perr := w.parse(data)
	if perr != nil {
		w.mu.Lock()
		w.err = perr
		w.mu.Unlock()
		log.Error().Str("path", w.o.Path).Str("error", perr.Error()).Msg("config file invalid; keeping the last good config")
		return
	}
	next := State[T]{Present: true, Value: v}
	w.mu.Lock()
	prev := w.cur
	w.cur, w.loadedAt, w.loaded, w.err = next, w.o.Now(), true, nil
	w.mu.Unlock()
	log.Info().Str("path", w.o.Path).Msg("config reloaded")
	w.o.Apply(ctx, Change[T]{Prev: prev, Next: next})
}

// changedOnDisk compares the file's stat with the last check.
func (w *Watcher[T]) changedOnDisk() bool {
	info, err := os.Stat(w.o.Path)
	w.mu.Lock()
	defer w.mu.Unlock()
	if err != nil {
		return w.exists || !errors.Is(err, fs.ErrNotExist)
	}
	return !w.exists || !info.ModTime().Equal(w.mtime) || info.Size() != w.size
}

// Run watches the file until ctx is done: fsnotify on its directory (a
// rename-based write replaces the inode, so watching the file itself
// would miss it), debounced, plus an mtime/size poll every Options.Poll.
func (w *Watcher[T]) Run(ctx context.Context) {
	var events <-chan fsnotify.Event
	var errs <-chan error
	if !w.o.NoNotify {
		if fw, err := fsnotify.NewWatcher(); err != nil {
			w.o.Log.Warn().Err(err).Msg("config: fsnotify unavailable; polling only")
		} else {
			defer fw.Close()
			if err := fw.Add(filepath.Dir(w.o.Path)); err != nil {
				w.o.Log.Warn().Err(err).Str("dir", filepath.Dir(w.o.Path)).Msg("config: can't watch the directory; polling only")
			} else {
				events, errs = fw.Events, fw.Errors
			}
		}
	}
	poll := time.NewTicker(w.o.Poll)
	defer poll.Stop()
	debounce := time.NewTimer(time.Hour)
	debounce.Stop()
	base := filepath.Base(w.o.Path)
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			// The file itself, or a ..data-style symlink swap (Kubernetes
			// ConfigMaps) that changes what it points at.
			if name := filepath.Base(ev.Name); name == base || (len(name) > 1 && name[:2] == "..") {
				debounce.Reset(w.o.Debounce)
			}
		case err, ok := <-errs:
			if !ok {
				errs = nil
				continue
			}
			w.o.Log.Warn().Err(err).Msg("config: fsnotify error")
		case <-debounce.C:
			w.Check(ctx)
		case <-poll.C:
			if w.changedOnDisk() {
				w.Check(ctx)
			}
		}
	}
}

// StatusHandler serves status as JSON. A nil status means BOSON_CONFIG is
// unset ({"enabled": false, "ok": true}).
func StatusHandler(status func() Status) nethttp.Handler {
	return nethttp.HandlerFunc(func(rw nethttp.ResponseWriter, _ *nethttp.Request) {
		st := Status{OK: true, RestartRequired: []string{}}
		if status != nil {
			st = status()
		}
		rw.Header().Set("Content-Type", "application/json; charset=utf-8")
		rw.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(rw).Encode(st)
	})
}

// ChangedKeys lists the keys whose value differs between a and b (flat
// key → value maps, e.g. from a service's Flatten), sorted.
func ChangedKeys(a, b map[string]any) []string {
	var out []string
	for k, v := range a {
		if w, ok := b[k]; !ok || !equal(v, w) {
			out = append(out, k)
		}
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return out
}

func equal(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && bytes.Equal(x, y)
}
