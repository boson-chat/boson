package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// UpdaterService reports whether a newer release exists, in the states the
// renderer's About section shows (the Electron build's UpdateState).
//
// For now it only checks: a newer version is reported as "available" with
// manual=true, and Apply opens the release page. Downloading and installing
// in place comes with the signed update feed (docs/wails-migration.md,
// Phase 5). Dev and e2e builds never reach GitHub: a check reports up to date.
type UpdaterService struct {
	current string
	check   bool

	mu    sync.Mutex
	state UpdateState
}

type UpdateState struct {
	Kind      string `json:"kind"` // idle | checking | up-to-date | available | error
	Version   string `json:"version,omitempty"`
	CheckedAt int64  `json:"checkedAt,omitempty"`
	Message   string `json:"message,omitempty"`
	// Manual: this build can't install it itself; Apply opens the release page.
	Manual bool `json:"manual,omitempty"`
}

const (
	UpdaterStateEvent = "updater:state"
	releasesAPI       = "https://api.github.com/repos/boson-chat/boson/releases/latest"
	releasesPage      = "https://github.com/boson-chat/boson/releases/latest"
	updateFirstCheck  = 10 * time.Second
	updateInterval    = 6 * time.Hour
)

func NewUpdaterService(current string, checkOnline bool) *UpdaterService {
	return &UpdaterService{current: current, check: checkOnline, state: UpdateState{Kind: "idle"}}
}

func (u *UpdaterService) GetState() UpdateState {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state
}

func (u *UpdaterService) set(s UpdateState) {
	u.mu.Lock()
	u.state = s
	u.mu.Unlock()
	application.Get().Event.Emit(UpdaterStateEvent, s)
}

func (u *UpdaterService) CheckNow(ctx context.Context) {
	if !u.check {
		u.set(UpdateState{Kind: "up-to-date", CheckedAt: time.Now().UnixMilli()})
		return
	}
	u.set(UpdateState{Kind: "checking"})
	latest, err := latestRelease(ctx)
	switch {
	case err != nil:
		// Offline or rate-limited: transient, so back to idle rather than an error.
		u.set(UpdateState{Kind: "idle"})
	case newerVersion(latest, u.current):
		u.set(UpdateState{Kind: "available", Version: latest, Manual: true})
	default:
		u.set(UpdateState{Kind: "up-to-date", CheckedAt: time.Now().UnixMilli()})
	}
}

// ApplyDownloadedUpdate opens the release page (see the type comment).
func (u *UpdaterService) ApplyDownloadedUpdate() error {
	return application.Get().Browser.OpenURL(releasesPage)
}

func (u *UpdaterService) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
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
				u.CheckNow(ctx)
				t.Reset(updateInterval)
			}
		}
	}()
	return nil
}

func latestRelease(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesAPI, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", &http.ProtocolError{ErrorString: res.Status}
	}
	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", err
	}
	return strings.TrimPrefix(body.TagName, "v"), nil
}

// newerVersion: whether a (x.y.z) is newer than b. Unparseable → false.
func newerVersion(a, b string) bool {
	pa, oka := semver(a)
	pb, okb := semver(b)
	if !oka || !okb {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func semver(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
