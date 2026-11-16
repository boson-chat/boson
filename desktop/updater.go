package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/boson-chat/boson/desktop/internal/selfupdate"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// UpdaterService keeps the app up to date from GitHub releases, in the
// states the renderer's Settings → About shows (UpdateState in
// UserSettings.tsx):
//
//	idle → checking → up-to-date
//	                → available → (the user clicks Update) downloading N% → ready
//	                                 → (Restart to update) swap + relaunch
//
// A release is installed in place only when it carries an update manifest
// signed with one of selfupdate's trusted keys, and the download matches it
// (size, sha256). Otherwise ("manual") Apply opens the release page: a
// release without a manifest (built without the signing key), a copy too old
// for in-place updates, or one macOS runs translocated or from a read-only
// disk. Nothing is installed without the user's click, unless they turned on
// "Install updates automatically" (then it downloads by itself and is
// swapped in when the app quits).
//
// Installing: macOS replaces the .app bundle, Windows and Linux the
// executable (selfupdate.Swap: rename the old one aside, the new one in),
// then the new copy is started and this one quits; the session is on disk,
// so the user stays signed in. Android hands the verified APK to the system
// package installer. iOS has no self-update (the renderer hides it).
//
// Dev and e2e builds don't check, unless pointed at a feed
// (BOSON_UPDATE_FEED; with BOSON_UPDATE_TEST_KEY, a key of the test feed's).
type UpdaterService struct {
	current string
	check   bool
	feed    string
	keys    []ed25519.PublicKey
	links   *LinksService
	dataDir string
	goos    string
	goarch  string
	client  *http.Client

	// Swappable for tests.
	emit       func(UpdateState)
	executable func() (string, error)
	relaunch   func(goos, target string, env []string) error
	quit       func()
	installAPK func(path string) error

	ctx context.Context

	// Dev builds only (main.go): the env a relaunch passes on (BOSON_*, so
	// a test profile stays a test profile), and autoApply
	// (BOSON_UPDATE_AUTOAPPLY=1): download and restart into an update with
	// no clicks — how scripts/e2e-update-macos.sh drives a real update.
	relaunchEnv []string
	autoApply   bool

	mu       sync.Mutex
	state    UpdateState
	busy     bool // a check or download is running
	pending  bool // the latest release is still being built (recheck soon)
	now      func() time.Time
	release  *selfupdate.Release
	asset    selfupdate.Asset
	target   string // what's replaced: the .app bundle or the executable
	staged   string // ready: what Apply installs
	settings updaterSettings
	// The installed version when the offered notes span several releases
	// (see UpdateState.NotesSince).
	notesSince string
}

type UpdateState struct {
	Kind      string `json:"kind"` // idle | checking | up-to-date | available | downloading | ready | error
	Version   string `json:"version,omitempty"`
	CheckedAt int64  `json:"checkedAt,omitempty"`
	// Message: an error's text, or why an available update must be
	// installed by hand.
	Message string `json:"message,omitempty"`
	// Notes: the release's notes, shortened to a few plain-text lines.
	// When the installed copy is more than one release behind, every
	// release since it, newest first, each under its version.
	Notes string `json:"notes,omitempty"`
	// NotesSince: the installed version, when Notes covers every release
	// after it (more than one).
	NotesSince     string  `json:"notesSince,omitempty"`
	Percent        float64 `json:"percent,omitempty"`
	BytesPerSecond float64 `json:"bytesPerSecond,omitempty"`
	// Manual: this copy can't install it itself; Apply opens the release page.
	Manual bool `json:"manual,omitempty"`
}

type updaterSettings struct {
	AutoInstall bool `json:"autoInstall"`
}

const (
	UpdaterStateEvent = "updater:state"
	releasesPage      = "https://github.com/boson-chat/boson/releases/latest"
	updateFirstCheck  = 10 * time.Second
	updateInterval    = 6 * time.Hour
	// A release younger than this whose build for this platform isn't
	// attached yet (CI attaches the builds 10-20 minutes after the release
	// is created) is still being built: nothing is offered, and the next
	// check comes after updatePendingRecheck instead of updateInterval.
	updatePendingWindow  = 3 * time.Hour
	updatePendingRecheck = 3 * time.Minute
	updateNotesItems     = 6
	// Several releases behind: up to this many entries from each, for up to
	// this many releases.
	updateNotesPerRelease = 4
	updateNotesReleases   = 8
)

func NewUpdaterService(current string, checkOnline bool, links *LinksService, dataDir string) *UpdaterService {
	u := &UpdaterService{
		now:     time.Now,
		current: current,
		check:   checkOnline,
		feed:    selfupdate.DefaultFeed,
		keys:    selfupdate.TrustedKeys(),
		links:   links,
		dataDir: dataDir,
		goos:    runtime.GOOS,
		goarch:  runtime.GOARCH,
		client: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ResponseHeaderTimeout: 30 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
		}},
		emit:       func(s UpdateState) { application.Get().Event.Emit(UpdaterStateEvent, s) },
		executable: os.Executable,
		relaunch:   selfupdate.Relaunch,
		quit:       func() { application.Get().Quit() },
		installAPK: installAPK,
		ctx:        context.Background(),
		state:      UpdateState{Kind: "idle"},
	}
	u.settings = u.loadSettings()
	return u
}

// useTestFeed points a dev build at another feed, trusting extra keys.
func (u *UpdaterService) useTestFeed(feed string, keys ...string) error {
	extra, err := selfupdate.ParseKeys(keys...)
	if err != nil {
		return err
	}
	u.feed, u.check = feed, true
	u.keys = append(u.keys, extra...)
	return nil
}

func (u *UpdaterService) GetState() UpdateState {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state
}

func (u *UpdaterService) set(s UpdateState) {
	u.mu.Lock()
	if s.Notes != "" && s.NotesSince == "" {
		s.NotesSince = u.notesSince
	}
	u.state = s
	u.mu.Unlock()
	u.emit(s)
}

// CheckNow is the About panel's "Check for updates".
func (u *UpdaterService) CheckNow(ctx context.Context) {
	u.checkOnce(context.WithoutCancel(ctx), true)
}

// checkOnce: manual reports a failed check as an error; a background check
// that fails (offline, rate-limited) just goes back to idle.
func (u *UpdaterService) checkOnce(ctx context.Context, manual bool) {
	if u.checkRelease(ctx, manual) {
		u.Download()
	}
}

// checkRelease reports whether to start downloading by itself (automatic
// installs are on).
func (u *UpdaterService) checkRelease(ctx context.Context, manual bool) (autoDownload bool) {
	if !u.check {
		u.set(UpdateState{Kind: "up-to-date", CheckedAt: time.Now().UnixMilli()})
		return false
	}
	u.mu.Lock()
	if u.busy || u.state.Kind == "downloading" || u.state.Kind == "ready" {
		u.mu.Unlock()
		return false
	}
	u.busy = true
	u.pending = false
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.busy = false; u.mu.Unlock() }()

	transient := func(err error) {
		log.Printf("updater: check: %v", err)
		if manual {
			u.set(UpdateState{Kind: "error", Message: "Couldn't reach the update server. Check your connection and try again."})
		} else {
			u.set(UpdateState{Kind: "idle"})
		}
	}
	u.set(UpdateState{Kind: "checking"})
	rel, err := selfupdate.FetchRelease(ctx, u.client, u.feed)
	if err != nil {
		transient(err)
		return false
	}
	if !selfupdate.Newer(rel.Version, u.current) {
		u.set(UpdateState{Kind: "up-to-date", CheckedAt: time.Now().UnixMilli()})
		return false
	}
	notes := selfupdate.ShortNotes(rel.Notes, updateNotesItems)
	// More than one release behind: what's new in each of them, not just
	// the latest (a failed list keeps the latest's notes).
	since := ""
	if list, err := selfupdate.FetchNotesSince(ctx, u.client, u.feed, u.current, rel.Version); err != nil {
		log.Printf("updater: release notes: %v", err)
	} else if len(list) > 1 {
		notes = selfupdate.CombinedNotes(list, updateNotesPerRelease, updateNotesReleases)
		since = u.current
	}
	u.mu.Lock()
	u.notesSince = since
	u.mu.Unlock()
	// notBuiltYet: a fresh release whose build isn't up yet isn't offered
	// (its button could only open the release page); check again soon.
	notBuiltYet := func() bool {
		if rel.PublishedAt.IsZero() || u.now().Sub(rel.PublishedAt) > updatePendingWindow {
			return false
		}
		log.Printf("updater: v%s is still being built; checking again in %v", rel.Version, updatePendingRecheck)
		u.mu.Lock()
		u.pending = true
		u.mu.Unlock()
		if manual {
			u.set(UpdateState{Kind: "up-to-date", CheckedAt: time.Now().UnixMilli(),
				Message: fmt.Sprintf("v%s is still being built. It will be offered when it's ready.", rel.Version)})
		} else {
			u.set(UpdateState{Kind: "idle"})
		}
		return true
	}
	offerManual := func(why string) {
		u.mu.Lock()
		u.release, u.asset = rel, selfupdate.Asset{}
		u.mu.Unlock()
		u.set(UpdateState{Kind: "available", Version: rel.Version, Manual: true, Message: why, Notes: notes})
	}
	if u.goos == "ios" {
		offerManual("")
		return false
	}
	m, err := rel.Manifest(ctx, u.client, u.keys)
	switch {
	case errors.Is(err, selfupdate.ErrNoManifest):
		if !notBuiltYet() {
			offerManual("")
		}
		return false
	case errors.Is(err, selfupdate.ErrUnsigned), errors.Is(err, selfupdate.ErrBadSignature), errors.Is(err, selfupdate.ErrBadManifest):
		log.Printf("updater: v%s refused: %v", rel.Version, err)
		u.set(UpdateState{Kind: "error", Version: rel.Version,
			Message: fmt.Sprintf("v%s failed signature verification, so it won't be installed.", rel.Version)})
		return false
	case err != nil:
		transient(err)
		return false
	}
	if m.Version != rel.Version {
		log.Printf("updater: release v%s carries a manifest for v%s", rel.Version, m.Version)
		u.set(UpdateState{Kind: "error", Version: rel.Version,
			Message: fmt.Sprintf("v%s's update manifest is for another version, so it won't be installed.", rel.Version)})
		return false
	}
	asset, err := m.For(u.current, selfupdate.PlatformKey(u.goos, u.goarch))
	switch {
	case errors.Is(err, selfupdate.ErrTooOld):
		offerManual(fmt.Sprintf("v%s can't be installed over v%s in place: download it from the release page.", rel.Version, u.current))
		return false
	case errors.Is(err, selfupdate.ErrNoAsset):
		if !notBuiltYet() {
			offerManual("")
		}
		return false
	case err != nil:
		u.set(UpdateState{Kind: "up-to-date", CheckedAt: time.Now().UnixMilli()})
		return false
	}
	if _, ok := rel.Assets[asset.Name]; !ok {
		// Not uploaded (yet): wait for it while the release is fresh, then
		// the release page.
		if !notBuiltYet() {
			offerManual("")
		}
		return false
	}
	target, err := u.locate()
	if err != nil {
		offerManual(err.Error())
		return false
	}
	u.mu.Lock()
	u.release, u.asset, u.target = rel, asset, target
	auto := u.settings.AutoInstall || u.autoApply
	u.mu.Unlock()
	u.set(UpdateState{Kind: "available", Version: rel.Version, Notes: notes})
	return auto
}

// locate: what an update replaces ("" on Android: the system installs it).
func (u *UpdaterService) locate() (string, error) {
	if u.goos == "android" {
		return "", nil
	}
	exe, err := u.executable()
	if err != nil {
		return "", err
	}
	return selfupdate.Locate(u.goos, exe)
}

// Download starts downloading the available update (the About panel's
// "Update to vX"); it's checked, unpacked and staged beside the app, then
// the state turns "ready".
func (u *UpdaterService) Download() {
	u.mu.Lock()
	if u.busy || u.state.Kind != "available" || u.state.Manual || u.asset.Name == "" || u.release == nil {
		u.mu.Unlock()
		return
	}
	u.busy = true
	rel, asset, target, notes := u.release, u.asset, u.target, u.state.Notes
	u.mu.Unlock()
	go func() {
		defer func() { u.mu.Lock(); u.busy = false; u.mu.Unlock() }()
		staged, err := u.download(rel, asset, target, notes)
		if err != nil {
			log.Printf("updater: v%s: %v", rel.Version, err)
			u.set(UpdateState{Kind: "error", Version: rel.Version, Message: err.Error()})
			return
		}
		u.mu.Lock()
		u.staged = staged
		u.mu.Unlock()
		u.set(UpdateState{Kind: "ready", Version: rel.Version, Notes: notes})
		if u.autoApply {
			u.ApplyDownloadedUpdate()
		}
	}()
}

func (u *UpdaterService) download(rel *selfupdate.Release, asset selfupdate.Asset, target, notes string) (string, error) {
	ra, ok := rel.Assets[asset.Name]
	if !ok {
		return "", fmt.Errorf("v%s is missing its download (%s).", rel.Version, asset.Name)
	}
	dir := u.downloadDir()
	os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	dst := filepath.Join(dir, asset.Name)
	start, last := time.Now(), time.Time{}
	lastPct := -1.0
	u.set(UpdateState{Kind: "downloading", Version: rel.Version, Notes: notes})
	progress := func(done, total int64) {
		pct := float64(int(float64(done) * 100 / float64(total)))
		if pct == lastPct || (time.Since(last) < 200*time.Millisecond && done < total) {
			return
		}
		lastPct, last = pct, time.Now()
		bps := 0.0
		if s := time.Since(start).Seconds(); s > 0 {
			bps = float64(done) / s
		}
		u.set(UpdateState{Kind: "downloading", Version: rel.Version, Notes: notes, Percent: pct, BytesPerSecond: bps})
	}
	if err := selfupdate.Download(u.ctx, u.client, ra.URL, dst, asset, progress); err != nil {
		if errors.Is(err, selfupdate.ErrSize) || errors.Is(err, selfupdate.ErrChecksum) {
			return "", fmt.Errorf("The download of v%s didn't match its signed manifest, so it was discarded.", rel.Version)
		}
		return "", fmt.Errorf("Downloading v%s failed. Try again later.", rel.Version)
	}
	staged, err := u.stage(dst, target, rel.Version)
	if err != nil {
		log.Printf("updater: staging v%s: %v", rel.Version, err)
		return "", fmt.Errorf("v%s couldn't be prepared for install: %v", rel.Version, err)
	}
	return staged, nil
}

// stage unpacks a verified payload beside target (Android: the APK itself).
func (u *UpdaterService) stage(payload, target, version string) (string, error) {
	switch u.goos {
	case "android":
		return payload, nil
	case "darwin":
		defer os.Remove(payload)
		return selfupdate.StageMacApp(payload, target, version)
	case "windows", "linux":
		defer os.Remove(payload)
		entry := "Boson/boson"
		if u.goos == "windows" {
			entry = "Boson/Boson.exe"
		}
		selfupdate.Cleanup(target)
		staged := selfupdate.StagedPath(target)
		if err := selfupdate.ExtractFile(payload, entry, staged); err != nil {
			return "", err
		}
		return staged, nil
	}
	return "", errors.New("this platform doesn't update in place")
}

// downloadDir holds a download until it's staged. On Android it's
// <files>/updates, the folder the shell's FileProvider shares with the
// package installer (HOME is the files dir: main_android.go).
func (u *UpdaterService) downloadDir() string {
	if u.goos == "android" {
		if home := os.Getenv("HOME"); home != "" {
			return filepath.Join(home, "updates")
		}
	}
	return filepath.Join(u.dataDir, "updates")
}

// ApplyDownloadedUpdate: "Restart to update" for a ready update (Android:
// hands the APK to the installer); for one this copy can't install, opens
// the release page.
func (u *UpdaterService) ApplyDownloadedUpdate() error {
	u.mu.Lock()
	st, staged, target := u.state, u.staged, u.target
	page := releasesPage
	if u.release != nil && u.release.PageURL != "" {
		page = u.release.PageURL
	}
	u.mu.Unlock()
	if st.Kind != "ready" || staged == "" {
		return u.links.Open(page)
	}
	if u.goos == "android" {
		return u.installAPK(staged)
	}
	if err := u.install(target, staged); err != nil {
		u.set(UpdateState{Kind: "error", Version: st.Version, Message: fmt.Sprintf("Installing v%s failed: %v", st.Version, err)})
		return err
	}
	if err := u.relaunch(u.goos, target, u.relaunchEnv); err != nil {
		log.Printf("updater: relaunch: %v", err)
		u.set(UpdateState{Kind: "error", Version: st.Version,
			Message: fmt.Sprintf("v%s is installed. Quit and reopen Boson to start it.", st.Version)})
		return err
	}
	u.quit()
	return nil
}

func (u *UpdaterService) install(target, staged string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.staged == "" {
		return nil // already installed (Apply, then quit)
	}
	if err := selfupdate.Swap(target, staged); err != nil {
		return err
	}
	u.staged = ""
	return nil
}

func (u *UpdaterService) GetAutoInstall() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.settings.AutoInstall
}

// SetAutoInstall: "Install updates automatically" (off by default).
func (u *UpdaterService) SetAutoInstall(on bool) error {
	u.mu.Lock()
	u.settings.AutoInstall = on
	s := u.settings
	available := u.state.Kind == "available" && !u.state.Manual
	u.mu.Unlock()
	if on && available {
		u.Download()
	}
	b, _ := json.Marshal(s)
	return os.WriteFile(u.settingsPath(), b, 0o600)
}

func (u *UpdaterService) settingsPath() string { return filepath.Join(u.dataDir, "updater.json") }

func (u *UpdaterService) loadSettings() updaterSettings {
	var s updaterSettings
	if b, err := os.ReadFile(u.settingsPath()); err == nil {
		json.Unmarshal(b, &s)
	}
	return s
}

func (u *UpdaterService) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	u.ctx = ctx
	// What a previous update left: the replaced copy, an unapplied one.
	if target, err := u.locate(); err == nil && target != "" {
		selfupdate.Cleanup(target)
	}
	os.RemoveAll(u.downloadDir())
	if !u.check {
		return nil
	}
	go func() {
		t := time.NewTimer(updateFirstCheck)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				u.checkOnce(ctx, false)
				u.mu.Lock()
				next := updateInterval
				if u.pending {
					next = updatePendingRecheck
				}
				u.mu.Unlock()
				t.Reset(next)
			}
		}
	}()
	return nil
}

// ServiceShutdown installs a ready update on quit when the user turned on
// automatic installs (the next launch is the new version).
func (u *UpdaterService) ServiceShutdown() error {
	u.mu.Lock()
	auto, ready, target, staged := u.settings.AutoInstall, u.state.Kind == "ready", u.target, u.staged
	u.mu.Unlock()
	if auto && ready && staged != "" && u.goos != "android" {
		if err := u.install(target, staged); err != nil {
			log.Printf("updater: install on quit: %v", err)
		}
	}
	return nil
}

// newerVersion: whether a (x.y.z) is newer than b. Unparseable → false.
func newerVersion(a, b string) bool { return selfupdate.Newer(a, b) }
