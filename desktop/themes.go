package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// ThemesService moves the user's theme files in and out of <data dir>/themes
// (<id>.json). The renderer parses and validates them (theme.parse.ts), so
// this never needs the format. Ids are a file-name-safe alphabet, which also
// keeps every path inside the folder. Edits on disk (any editor) emit
// ThemesChangedEvent, so they apply live.
type ThemesService struct {
	dir string

	mu      sync.Mutex
	watcher *fsnotify.Watcher
}

const ThemesChangedEvent = "themes:changed"

var themeID = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9_-]{0,63}$`)

const (
	themeMaxBytes = 64 * 1024
	themeMaxFiles = 200
)

type ThemeFile struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

func NewThemesService(dataDir string) *ThemesService {
	return &ThemesService{dir: filepath.Join(dataDir, "themes")}
}

func (t *ThemesService) ensureDir() error {
	if _, err := os.Stat(t.dir); err == nil {
		return nil
	}
	if err := os.MkdirAll(t.dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(t.dir, "README.txt"), []byte(themesReadme), 0o644)
}

func (t *ThemesService) List() ([]ThemeFile, error) {
	if err := t.ensureDir(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(t.dir)
	if err != nil {
		return nil, err
	}
	out := []ThemeFile{}
	n := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".json") {
			continue
		}
		if n++; n > themeMaxFiles {
			break
		}
		id := name[:len(name)-len(".json")]
		if !themeID.MatchString(id) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue // gone since ReadDir; the watcher refreshes
		}
		if info.Size() > themeMaxBytes {
			// Too big to be a theme: something the renderer reports as an error.
			out = append(out, ThemeFile{ID: id, Text: `"too large"`})
			continue
		}
		b, err := os.ReadFile(filepath.Join(t.dir, name))
		if err != nil {
			continue
		}
		out = append(out, ThemeFile{ID: id, Text: string(b)})
	}
	return out, nil
}

func (t *ThemesService) Write(id, text string) error {
	if !themeID.MatchString(id) {
		return errors.New("themes: bad theme id")
	}
	if len(text) > themeMaxBytes {
		return errors.New("themes: theme must be under 64 KB")
	}
	if err := t.ensureDir(); err != nil {
		return err
	}
	// Write-then-rename so the watcher (or an editor) never sees half a file.
	tmp := filepath.Join(t.dir, "."+id+".json.tmp")
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(t.dir, id+".json"))
}

// Remove deletes a theme; the renderer asks the user to confirm first.
func (t *ThemesService) Remove(id string) error {
	if !themeID.MatchString(id) {
		return errors.New("themes: bad theme id")
	}
	err := os.Remove(filepath.Join(t.dir, id+".json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (t *ThemesService) OpenFolder() error {
	if err := t.ensureDir(); err != nil {
		return err
	}
	return application.Get().Browser.OpenFile(t.dir)
}

// ServiceStartup starts watching the folder.
func (t *ThemesService) ServiceStartup(_ context.Context, _ application.ServiceOptions) error {
	if err := t.ensureDir(); err != nil {
		return nil // no folder, no live reload; List still reports the error
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil
	}
	if err := w.Add(t.dir); err != nil {
		w.Close()
		return nil
	}
	t.mu.Lock()
	t.watcher = w
	t.mu.Unlock()
	go t.watch(w)
	return nil
}

func (t *ThemesService) watch(w *fsnotify.Watcher) {
	var timer *time.Timer
	for {
		select {
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			// Only our own write-then-rename temp files are skipped.
			if strings.HasSuffix(ev.Name, ".json.tmp") {
				continue
			}
			if timer != nil {
				timer.Stop()
			}
			timer = time.AfterFunc(150*time.Millisecond, func() {
				application.Get().Event.Emit(ThemesChangedEvent)
			})
		case _, ok := <-w.Errors:
			if !ok {
				return
			}
		}
	}
}

func (t *ThemesService) ServiceShutdown() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.watcher != nil {
		t.watcher.Close()
		t.watcher = nil
	}
	return nil
}

const themesReadme = `Boson themes
============

Every .json file in this folder is a theme. Edit one in any editor and Boson
re-applies it as soon as you save. Make a new one from Settings > Appearance
(Customize) or by copying an existing file.

{
  "name": "My theme",
  "base": "dark",
  "colors": {
    "bg": "#070709",
    "surface": "#0D0D11",
    "surface-raised": "#141418",
    "surface-hover": "#1A1A20",
    "border": "#24242E",
    "border-soft": "#1C1C24",
    "fg": "#E2E2EA",
    "fg-2": "#9898A8",
    "fg-3": "#686878",
    "muted": "#444452",
    "meta": "#363644",
    "accent": "#D97706",
    "accent-on": "#070709",
    "success": "#10B981",
    "warn": "#F59E0B",
    "danger": "#EF4444",
    "info": "#3B82F6"
  },
  "nick": { "saturation": 62, "lightness": 64 },
  "radius": 2,
  "font": "boson"
}

"base" is "dark" or "light". Anything you leave out comes from the built-in
theme of that base. Colours are CSS colours: #hex, rgb(), hsl(), oklch(), or
names. "nick" sets the saturation and lightness (0-100) of nick avatars.
"radius" is the corner rounding in px (0-12; Boson's own is 2, the macOS look
uses 5). "font" is "boson" (Inter + JetBrains Mono) or "system" (your OS's
UI font).
`
