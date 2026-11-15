package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boson-chat/boson/desktop/internal/selfupdate"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.37.0", "0.36.4", true},
		{"v1.0.0", "0.99.99", true},
		{"0.36.4", "0.36.4", false},
		{"0.36.3", "0.36.4", false},
		{"0.36.10", "0.36.9", true},
		{"0.37.0-beta.1", "0.36.4", true},
		{"garbage", "0.36.4", false},
		{"0.37.0", "dev", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// testRelease is a fake GitHub release feed serving a Linux tar.gz.
type testRelease struct {
	tag      string
	manifest []byte // nil: none published
	sig      []byte // nil: none published
	payload  []byte
}

func linuxPayload(t *testing.T, exe string) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "Boson/boson", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(exe))})
	tw.Write([]byte(exe))
	tw.Close()
	gz.Close()
	return b.Bytes()
}

func signedManifest(t *testing.T, priv ed25519.PrivateKey, version, minVersion string, payload []byte) ([]byte, []byte) {
	t.Helper()
	s := sha256.Sum256(payload)
	m, _ := json.Marshal(selfupdate.Manifest{Schema: 1, Version: version, MinVersion: minVersion, Assets: map[string]selfupdate.Asset{
		"linux-amd64": {Name: "Boson-linux-x86_64.tar.gz", Size: int64(len(payload)), SHA256: hex.EncodeToString(s[:])},
	}})
	return m, []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, m)))
}

func (r testRelease) serve(t *testing.T) *httptest.Server {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		files := map[string][]byte{"Boson-linux-x86_64.tar.gz": r.payload}
		if r.manifest != nil {
			files[selfupdate.ManifestAsset] = r.manifest
		}
		if r.sig != nil {
			files[selfupdate.SignatureAsset] = r.sig
		}
		if req.URL.Path == "/latest" {
			var assets []map[string]any
			for name, b := range files {
				assets = append(assets, map[string]any{"name": name, "size": len(b), "browser_download_url": srv.URL + "/dl/" + name})
			}
			json.NewEncoder(w).Encode(map[string]any{"tag_name": "v" + r.tag, "html_url": srv.URL + "/page",
				"body": "## " + r.tag + "\n\n### Features\n\n* **desktop:** in-app updates ([#60](https://x/60))\n", "assets": assets})
			return
		}
		if b, ok := files[strings.TrimPrefix(req.URL.Path, "/dl/")]; ok {
			w.Write(b)
			return
		}
		http.NotFound(w, req)
	}))
	t.Cleanup(srv.Close)
	return srv
}

type harness struct {
	u        *UpdaterService
	exe      string
	mu       sync.Mutex
	states   []UpdateState
	relaunch []string
	quits    int
}

func newHarness(t *testing.T, feed string, pub ed25519.PublicKey) *harness {
	t.Helper()
	h := &harness{}
	dir := t.TempDir()
	h.exe = filepath.Join(dir, "boson")
	os.WriteFile(h.exe, []byte("old"), 0o755)
	u := NewUpdaterService("1.0.0", true, &LinksService{record: true}, t.TempDir())
	u.goos, u.goarch = "linux", "amd64"
	u.feed = feed
	u.keys = []ed25519.PublicKey{pub}
	u.emit = func(s UpdateState) { h.mu.Lock(); h.states = append(h.states, s); h.mu.Unlock() }
	u.executable = func() (string, error) { return h.exe, nil }
	u.relaunch = func(goos, target string, _ []string) error { h.relaunch = append(h.relaunch, target); return nil }
	u.quit = func() { h.quits++ }
	h.u = u
	return h
}

func (h *harness) waitFor(t *testing.T, kind string) UpdateState {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if s := h.u.GetState(); s.Kind == kind {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("state %+v, want %s", h.u.GetState(), kind)
	return UpdateState{}
}

func testKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestUpdaterInstallsSignedUpdate(t *testing.T) {
	pub, priv := testKey(t)
	payload := linuxPayload(t, "new")
	m, sig := signedManifest(t, priv, "1.1.0", "0.1.0", payload)
	srv := testRelease{tag: "1.1.0", manifest: m, sig: sig, payload: payload}.serve(t)
	h := newHarness(t, srv.URL+"/latest", pub)

	h.u.CheckNow(context.Background())
	s := h.u.GetState()
	if s.Kind != "available" || s.Manual || s.Version != "1.1.0" || s.Notes != "Features\n• desktop: in-app updates" {
		t.Fatalf("after check: %+v", s)
	}
	// Nothing happens without the click.
	time.Sleep(50 * time.Millisecond)
	if h.u.GetState().Kind != "available" {
		t.Fatal("downloaded without being asked")
	}
	h.u.Download()
	h.waitFor(t, "ready")
	sawProgress := false
	for _, s := range h.states {
		if s.Kind == "downloading" && s.Percent == 100 {
			sawProgress = true
		}
	}
	if !sawProgress {
		t.Errorf("no downloading 100%% state in %+v", h.states)
	}
	if b, _ := os.ReadFile(h.exe); string(b) != "old" {
		t.Fatal("installed before Restart")
	}
	if err := h.u.ApplyDownloadedUpdate(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(h.exe); string(b) != "new" {
		t.Fatalf("after Restart the app is %q", b)
	}
	real, _ := filepath.EvalSymlinks(h.exe)
	if len(h.relaunch) != 1 || h.relaunch[0] != real || h.quits != 1 {
		t.Errorf("relaunch %v, quits %d", h.relaunch, h.quits)
	}
	// The next launch tidies up the replaced copy.
	if _, err := os.Stat(selfupdate.BackupPath(h.exe)); err != nil {
		t.Fatal("no backup of the replaced copy")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h.u.ServiceStartup(ctx, application.ServiceOptions{})
	if _, err := os.Stat(selfupdate.BackupPath(h.exe)); !os.IsNotExist(err) {
		t.Error("the replaced copy is still there after startup")
	}
}

func TestUpdaterRefuses(t *testing.T) {
	pub, priv := testKey(t)
	_, otherPriv := testKey(t)
	payload := linuxPayload(t, "new")
	good, goodSig := signedManifest(t, priv, "1.1.0", "", payload)
	_, wrongSig := signedManifest(t, otherPriv, "1.1.0", "", payload)
	replay, replaySig := signedManifest(t, priv, "0.9.0", "", payload)
	tooNew, tooNewSig := signedManifest(t, priv, "1.1.0", "1.0.5", payload)

	for _, c := range []struct {
		name    string
		rel     testRelease
		kind    string
		manual  bool
		message string
	}{
		{"no manifest: the release page", testRelease{tag: "1.1.0", payload: payload}, "available", true, ""},
		{"unsigned", testRelease{tag: "1.1.0", manifest: good, payload: payload}, "error", false, "failed signature verification"},
		{"wrong key", testRelease{tag: "1.1.0", manifest: good, sig: wrongSig, payload: payload}, "error", false, "failed signature verification"},
		{"truncated manifest", testRelease{tag: "1.1.0", manifest: good[:len(good)-5], sig: goodSig, payload: payload}, "error", false, "failed signature verification"},
		{"an old signed manifest replayed as a new release", testRelease{tag: "1.1.0", manifest: replay, sig: replaySig, payload: payload}, "error", false, "for another version"},
		{"too old to update in place", testRelease{tag: "1.1.0", manifest: tooNew, sig: tooNewSig, payload: payload}, "available", true, "can't be installed over v1.0.0"},
		{"same version", testRelease{tag: "1.0.0", manifest: good, sig: goodSig, payload: payload}, "up-to-date", false, ""},
		{"older release (downgrade)", testRelease{tag: "0.9.0", manifest: replay, sig: replaySig, payload: payload}, "up-to-date", false, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := c.rel.serve(t)
			h := newHarness(t, srv.URL+"/latest", pub)
			h.u.CheckNow(context.Background())
			s := h.u.GetState()
			if s.Kind != c.kind || s.Manual != c.manual || !strings.Contains(s.Message, c.message) {
				t.Fatalf("state %+v", s)
			}
			h.u.Download()
			time.Sleep(20 * time.Millisecond)
			if k := h.u.GetState().Kind; k == "downloading" || k == "ready" {
				t.Fatal("downloaded a refused update")
			}
			if s.Manual {
				h.u.ApplyDownloadedUpdate()
				if got := h.u.links.Opened(); len(got) != 1 || got[0] != srv.URL+"/page" {
					t.Errorf("opened %v", got)
				}
			}
		})
	}
}

func TestUpdaterRejectsTamperedDownload(t *testing.T) {
	pub, priv := testKey(t)
	payload := linuxPayload(t, "new")
	m, sig := signedManifest(t, priv, "1.1.0", "", payload)
	for name, served := range map[string][]byte{
		"truncated": payload[:len(payload)-3],
		"tampered":  append(append([]byte{}, payload[:len(payload)-1]...), payload[len(payload)-1]^1),
	} {
		t.Run(name, func(t *testing.T) {
			srv := testRelease{tag: "1.1.0", manifest: m, sig: sig, payload: served}.serve(t)
			h := newHarness(t, srv.URL+"/latest", pub)
			h.u.CheckNow(context.Background())
			h.u.Download()
			s := h.waitFor(t, "error")
			if !strings.Contains(s.Message, "didn't match its signed manifest") {
				t.Errorf("message %q", s.Message)
			}
			if _, err := os.Stat(selfupdate.StagedPath(h.exe)); !os.IsNotExist(err) {
				t.Error("staged anyway")
			}
			if err := h.u.ApplyDownloadedUpdate(); err != nil || h.quits != 0 {
				t.Errorf("apply after a rejected download: %v, quits %d", err, h.quits)
			}
			if b, _ := os.ReadFile(h.exe); string(b) != "old" {
				t.Error("the app was replaced")
			}
		})
	}
}

func TestUpdaterReadOnlyInstall(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	pub, priv := testKey(t)
	payload := linuxPayload(t, "new")
	m, sig := signedManifest(t, priv, "1.1.0", "", payload)
	srv := testRelease{tag: "1.1.0", manifest: m, sig: sig, payload: payload}.serve(t)
	h := newHarness(t, srv.URL+"/latest", pub)
	dir := filepath.Dir(h.exe)
	os.Chmod(dir, 0o555)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	h.u.CheckNow(context.Background())
	if s := h.u.GetState(); s.Kind != "available" || !s.Manual || !strings.Contains(s.Message, "can't write to") {
		t.Fatalf("state %+v", s)
	}
}

func TestUpdaterAutoInstall(t *testing.T) {
	pub, priv := testKey(t)
	payload := linuxPayload(t, "new")
	m, sig := signedManifest(t, priv, "1.1.0", "", payload)
	srv := testRelease{tag: "1.1.0", manifest: m, sig: sig, payload: payload}.serve(t)
	h := newHarness(t, srv.URL+"/latest", pub)
	if h.u.GetAutoInstall() {
		t.Fatal("automatic installs are on by default")
	}
	if err := h.u.SetAutoInstall(true); err != nil {
		t.Fatal(err)
	}
	// Persisted.
	if !NewUpdaterService("1.0.0", true, h.u.links, h.u.dataDir).GetAutoInstall() {
		t.Error("the setting wasn't saved")
	}
	h.u.CheckNow(context.Background())
	h.waitFor(t, "ready")
	// Installed on quit, without a relaunch.
	h.u.ServiceShutdown()
	if b, _ := os.ReadFile(h.exe); string(b) != "new" {
		t.Fatalf("after quit the app is %q", b)
	}
	if len(h.relaunch) != 0 {
		t.Error("relaunched on quit")
	}
}

func TestUpdaterDevBuildDoesNotCheck(t *testing.T) {
	u := NewUpdaterService("1.0.0", false, &LinksService{}, t.TempDir())
	var got []UpdateState
	u.emit = func(s UpdateState) { got = append(got, s) }
	u.CheckNow(context.Background())
	if len(got) != 1 || got[0].Kind != "up-to-date" {
		t.Errorf("states %+v", got)
	}
}
