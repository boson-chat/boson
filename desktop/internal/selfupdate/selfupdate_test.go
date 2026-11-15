package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func sign(priv ed25519.PrivateKey, b []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, b)) + "\n")
}

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func manifestJSON(t *testing.T, m Manifest) []byte {
	t.Helper()
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func sampleManifest(payload []byte) Manifest {
	return Manifest{
		Schema: 1, Version: "1.2.0", MinVersion: "1.0.0",
		Assets: map[string]Asset{
			"linux-amd64": {Name: "Boson-linux-x86_64.tar.gz", Size: int64(len(payload)), SHA256: sum(payload)},
		},
	}
}

func TestTrustedKeysParse(t *testing.T) {
	if len(TrustedKeys()) == 0 {
		t.Fatal("no trusted keys")
	}
}

func TestVerifyManifest(t *testing.T) {
	pub, priv := newKey(t)
	otherPub, otherPriv := newKey(t)
	m := manifestJSON(t, sampleManifest([]byte("payload")))
	good := sign(priv, m)

	if got, err := VerifyManifest(m, good, []ed25519.PublicKey{pub}); err != nil || got.Version != "1.2.0" {
		t.Fatalf("valid manifest: %v, %+v", err, got)
	}
	// A rotated-in second key verifies too.
	if _, err := VerifyManifest(m, sign(otherPriv, m), []ed25519.PublicKey{pub, otherPub}); err != nil {
		t.Fatalf("second key: %v", err)
	}

	tampered := bytes.Replace(m, []byte("1.2.0"), []byte("9.2.0"), 1)
	cases := []struct {
		name     string
		manifest []byte
		sig      []byte
		keys     []ed25519.PublicKey
		want     error
	}{
		{"unsigned", m, nil, []ed25519.PublicKey{pub}, ErrUnsigned},
		{"blank signature", m, []byte("  \n"), []ed25519.PublicKey{pub}, ErrUnsigned},
		{"wrong key", m, sign(otherPriv, m), []ed25519.PublicKey{pub}, ErrBadSignature},
		{"no keys", m, good, nil, ErrBadSignature},
		{"tampered manifest", tampered, good, []ed25519.PublicKey{pub}, ErrBadSignature},
		{"truncated manifest", m[:len(m)-10], good, []ed25519.PublicKey{pub}, ErrBadSignature},
		{"empty manifest", nil, good, []ed25519.PublicKey{pub}, ErrBadManifest},
		{"truncated signature", m, good[:40], []ed25519.PublicKey{pub}, ErrBadSignature},
		{"garbage signature", m, []byte("not base64!"), []ed25519.PublicKey{pub}, ErrBadSignature},
		{"signature over another manifest", m, sign(priv, tampered), []ed25519.PublicKey{pub}, ErrBadSignature},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := VerifyManifest(c.manifest, c.sig, c.keys)
			if !errors.Is(err, c.want) || got != nil {
				t.Fatalf("got %+v, %v; want %v", got, err, c.want)
			}
		})
	}
}

func TestVerifyManifestRejectsSignedButMalformed(t *testing.T) {
	pub, priv := newKey(t)
	bad := []Manifest{
		{Schema: 2, Version: "1.0.0"},
		{Schema: 1, Version: "latest"},
		{Schema: 1, Version: "1.0.0", MinVersion: "x"},
		{Schema: 1, Version: "1.0.0", Assets: map[string]Asset{"linux-amd64": {Name: "../evil", Size: 1, SHA256: sum(nil)}}},
		{Schema: 1, Version: "1.0.0", Assets: map[string]Asset{"linux-amd64": {Name: "a", Size: 0, SHA256: sum(nil)}}},
		{Schema: 1, Version: "1.0.0", Assets: map[string]Asset{"linux-amd64": {Name: "a", Size: 1, SHA256: "abc"}}},
	}
	for i, m := range bad {
		b := manifestJSON(t, m)
		if _, err := VerifyManifest(b, sign(priv, b), []ed25519.PublicKey{pub}); !errors.Is(err, ErrBadManifest) {
			t.Errorf("%d: %v, want ErrBadManifest", i, err)
		}
	}
	notJSON := []byte("{\"schema\":1,")
	if _, err := VerifyManifest(notJSON, sign(priv, notJSON), []ed25519.PublicKey{pub}); !errors.Is(err, ErrBadManifest) {
		t.Errorf("truncated but signed JSON: %v", err)
	}
}

func TestManifestFor(t *testing.T) {
	m := sampleManifest([]byte("x"))
	if _, err := m.For("1.1.9", "linux-amd64"); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	for _, c := range []struct {
		current, platform string
		want              error
	}{
		{"1.2.0", "linux-amd64", ErrDowngrade}, // same version
		{"1.3.0", "linux-amd64", ErrDowngrade}, // an older (replayed) manifest
		{"garbage", "linux-amd64", ErrDowngrade},
		{"0.9.0", "linux-amd64", ErrTooOld},
		{"1.1.0", "darwin-arm64", ErrNoAsset},
	} {
		if _, err := m.For(c.current, c.platform); !errors.Is(err, c.want) {
			t.Errorf("For(%s, %s) = %v, want %v", c.current, c.platform, err, c.want)
		}
	}
}

func TestCompare(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
		ok   bool
	}{
		{"0.37.0", "0.36.4", 1, true},
		{"v1.0.0", "0.99.99", 1, true},
		{"0.36.4", "0.36.4", 0, true},
		{"0.36.10", "0.36.9", 1, true},
		{"0.0.0-dev", "0.0.1", -1, true},
		{"1.0", "1.0.0", 0, false},
		{"1.-1.0", "1.0.0", 0, false},
	} {
		got, ok := Compare(c.a, c.b)
		if got != c.want || ok != c.ok {
			t.Errorf("Compare(%q, %q) = %d, %v", c.a, c.b, got, ok)
		}
	}
}

func TestDownload(t *testing.T) {
	payload := bytes.Repeat([]byte("boson"), 10000)
	want := Asset{Name: "p", Size: int64(len(payload)), SHA256: sum(payload)}
	serve := func(b []byte) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write(b) }))
	}
	tampered := append([]byte{}, payload...)
	tampered[100] ^= 1
	cases := []struct {
		name string
		body []byte
		want error
	}{
		{"truncated", payload[:len(payload)-1], ErrSize},
		{"longer", append(append([]byte{}, payload...), 'x'), ErrSize},
		{"tampered", tampered, ErrChecksum},
		{"empty", nil, ErrSize},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := serve(c.body)
			defer srv.Close()
			dst := filepath.Join(t.TempDir(), "payload")
			if err := Download(context.Background(), srv.Client(), srv.URL, dst, want, nil); !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
			for _, p := range []string{dst, dst + ".part"} {
				if _, err := os.Stat(p); !os.IsNotExist(err) {
					t.Errorf("%s left behind", p)
				}
			}
		})
	}

	srv := serve(payload)
	defer srv.Close()
	dst := filepath.Join(t.TempDir(), "payload")
	var last, total int64
	if err := Download(context.Background(), srv.Client(), srv.URL, dst, want, func(d, tt int64) { last, total = d, tt }); err != nil {
		t.Fatal(err)
	}
	if last != want.Size || total != want.Size {
		t.Errorf("progress ended at %d/%d", last, total)
	}
	if err := VerifyFile(dst, want); err != nil {
		t.Errorf("VerifyFile: %v", err)
	}
	if err := os.WriteFile(dst, payload[:10], 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyFile(dst, want); !errors.Is(err, ErrSize) {
		t.Errorf("VerifyFile on a truncated file: %v", err)
	}
}

// A GitHub-shaped feed with whichever assets are given.
func feedServer(t *testing.T, assets map[string][]byte) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/latest", func(w http.ResponseWriter, _ *http.Request) {
		type asset struct {
			Name string `json:"name"`
			Size int    `json:"size"`
			URL  string `json:"browser_download_url"`
		}
		var list []asset
		for name, b := range assets {
			list = append(list, asset{name, len(b), srv.URL + "/dl/" + name})
		}
		json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v1.2.0", "body": "## 1.2.0\n\n* a fix", "html_url": "https://example/rel", "assets": list,
		})
	})
	mux.HandleFunc("/dl/", func(w http.ResponseWriter, r *http.Request) {
		b, ok := assets[strings.TrimPrefix(r.URL.Path, "/dl/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestReleaseManifest(t *testing.T) {
	pub, priv := newKey(t)
	_, otherPriv := newKey(t)
	payload := []byte("the app")
	m := manifestJSON(t, sampleManifest(payload))
	ctx := context.Background()
	keys := []ed25519.PublicKey{pub}
	for _, c := range []struct {
		name   string
		assets map[string][]byte
		want   error
	}{
		{"no manifest (a fork's release)", map[string][]byte{"Boson-linux-x86_64.tar.gz": payload}, ErrNoManifest},
		{"manifest, no signature", map[string][]byte{ManifestAsset: m}, ErrUnsigned},
		{"signed with another key", map[string][]byte{ManifestAsset: m, SignatureAsset: sign(otherPriv, m)}, ErrBadSignature},
		{"signed", map[string][]byte{ManifestAsset: m, SignatureAsset: sign(priv, m)}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := feedServer(t, c.assets)
			rel, err := FetchRelease(ctx, srv.Client(), srv.URL+"/latest")
			if err != nil {
				t.Fatal(err)
			}
			if rel.Version != "1.2.0" || rel.PageURL != "https://example/rel" {
				t.Fatalf("release %+v", rel)
			}
			got, err := rel.Manifest(ctx, srv.Client(), keys)
			if !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
			if c.want == nil && got.Version != "1.2.0" {
				t.Fatalf("manifest %+v", got)
			}
		})
	}
}

func TestExtractFile(t *testing.T) {
	dir := t.TempDir()
	exe := []byte("#!/bin/sh\necho new\n")

	zipPath := filepath.Join(dir, "Boson-windows-x64.zip")
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	for name, b := range map[string][]byte{`Boson\Boson.exe`: exe, "Boson/readme.txt": []byte("hi")} {
		w, _ := zw.Create(name)
		w.Write(b)
	}
	zw.Close()
	os.WriteFile(zipPath, zb.Bytes(), 0o600)

	tgzPath := filepath.Join(dir, "Boson-linux-x86_64.tar.gz")
	var tb bytes.Buffer
	gz := gzip.NewWriter(&tb)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "Boson/", Typeflag: tar.TypeDir, Mode: 0o755})
	tw.WriteHeader(&tar.Header{Name: "Boson/boson", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(exe))})
	tw.Write(exe)
	tw.Close()
	gz.Close()
	os.WriteFile(tgzPath, tb.Bytes(), 0o600)

	for archive, entry := range map[string]string{zipPath: "Boson/Boson.exe", tgzPath: "Boson/boson"} {
		dst := filepath.Join(dir, "out-"+filepath.Base(archive))
		if err := ExtractFile(archive, entry, dst); err != nil {
			t.Fatalf("%s: %v", archive, err)
		}
		if got, _ := os.ReadFile(dst); !bytes.Equal(got, exe) {
			t.Errorf("%s: extracted %q", archive, got)
		}
		if err := ExtractFile(archive, "Boson/missing", dst+"x"); !errors.Is(err, errNoEntry) {
			t.Errorf("%s: missing entry: %v", archive, err)
		}
	}
}

// A fake app bundle: dir/Boson.app/Contents/MacOS/Boson holding body.
func fakeBundle(t *testing.T, at, body string) string {
	t.Helper()
	exe := filepath.Join(at, "Contents", "MacOS", "Boson")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSwapBundle(t *testing.T) {
	apps := t.TempDir()
	target := filepath.Join(apps, "Boson.app")
	exe := fakeBundle(t, target, "v1")
	if got, err := Locate("darwin", exe); err != nil || got != mustReal(t, target) {
		t.Fatalf("Locate = %q, %v", got, err)
	}
	staged := StagedPath(target)
	fakeBundle(t, staged, "v2")

	if err := Swap(target, staged); err != nil {
		t.Fatal(err)
	}
	if got := read(t, exe); got != "v2" {
		t.Errorf("after swap the bundle holds %q", got)
	}
	if got := read(t, filepath.Join(BackupPath(target), "Contents", "MacOS", "Boson")); got != "v1" {
		t.Errorf("the backup holds %q", got)
	}
	if _, err := os.Stat(staged); !os.IsNotExist(err) {
		t.Error("the staged copy is still there")
	}
	Cleanup(target)
	entries, _ := os.ReadDir(apps)
	if len(entries) != 1 || entries[0].Name() != "Boson.app" {
		t.Errorf("after Cleanup: %v", entries)
	}

	// Nothing staged: an error, and the app is untouched.
	if err := Swap(target, staged); err == nil {
		t.Error("swap with nothing staged succeeded")
	}
	if got := read(t, exe); got != "v2" {
		t.Errorf("a failed swap left %q", got)
	}
	// Staged somewhere else (another volume, say): refused.
	elsewhere := filepath.Join(t.TempDir(), "Boson.app")
	fakeBundle(t, elsewhere, "v3")
	if err := Swap(target, elsewhere); err == nil {
		t.Error("swap from another directory succeeded")
	}
}

func TestSwapExecutable(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "Boson.exe")
	os.WriteFile(target, []byte("old"), 0o755)
	if got, err := Locate(runtime.GOOS, target); runtime.GOOS != "darwin" && (err != nil || got != mustReal(t, target)) {
		t.Fatalf("Locate = %q, %v", got, err)
	}
	staged := StagedPath(target)
	os.WriteFile(staged, []byte("new"), 0o755)
	if err := Swap(target, staged); err != nil {
		t.Fatal(err)
	}
	if read(t, target) != "new" || read(t, BackupPath(target)) != "old" {
		t.Error("swap didn't replace the executable")
	}
}

func mustReal(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestLocateRefuses(t *testing.T) {
	// Translocated: macOS runs a quarantined app from a random read-only
	// mount under …/AppTranslocation/….
	trans := filepath.Join(t.TempDir(), "AppTranslocation", "1A2B", "d")
	exe := fakeBundle(t, filepath.Join(trans, "Boson.app"), "v1")
	_, err := Locate("darwin", exe)
	if ie, ok := IsInstallError(err); !ok || ie.Reason != "translocated" || !strings.Contains(err.Error(), "Applications folder") {
		t.Errorf("translocated: %v", err)
	}

	// A bare binary (go run, a dev build): not a bundle.
	bare := filepath.Join(t.TempDir(), "boson")
	os.WriteFile(bare, nil, 0o755)
	if ie, ok := IsInstallError(func() error { _, err := Locate("darwin", bare); return err }()); !ok || ie.Reason != "not-bundle" {
		t.Errorf("bare binary: %v", ie)
	}

	if _, err := Locate("ios", bare); err == nil {
		t.Error("ios: no error")
	}

	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		return // no read-only directories by mode there
	}
	ro := t.TempDir()
	exe = fakeBundle(t, filepath.Join(ro, "Boson.app"), "v1")
	linuxExe := filepath.Join(ro, "boson")
	os.WriteFile(linuxExe, nil, 0o755)
	os.Chmod(ro, 0o555)
	t.Cleanup(func() { os.Chmod(ro, 0o755) })
	_, err = Locate("darwin", exe)
	if ie, ok := IsInstallError(err); !ok || ie.Reason != "read-only" || !strings.Contains(err.Error(), "Applications folder") {
		t.Errorf("read-only (darwin): %v", err)
	}
	_, err = Locate("linux", linuxExe)
	if ie, ok := IsInstallError(err); !ok || ie.Reason != "read-only" {
		t.Errorf("read-only (linux): %v", err)
	}
}

func TestWaitForRelaunch(t *testing.T) {
	args := []string{"boson://x", RelaunchFlag + "999999999", "--other"}
	start := time.Now()
	got := WaitForRelaunch(args, 2*time.Second)
	if strings.Join(got, " ") != "boson://x --other" {
		t.Errorf("args = %v", got)
	}
	if time.Since(start) > time.Second {
		t.Error("waited for a process that doesn't exist")
	}

	// A live process: waited for until it exits.
	cmd := helperSleep(t)
	go func() { time.Sleep(300 * time.Millisecond); cmd.Process.Kill(); cmd.Wait() }()
	start = time.Now()
	WaitForRelaunch([]string{RelaunchFlag + strconv.Itoa(cmd.Process.Pid)}, 10*time.Second)
	if d := time.Since(start); d < 250*time.Millisecond || d > 8*time.Second {
		t.Errorf("waited %v", d)
	}
}

func helperSleep(t *testing.T) *exec.Cmd {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 30")
	} else {
		cmd = exec.Command("sleep", "30")
	}
	if err := cmd.Start(); err != nil {
		t.Skip("no sleep command:", err)
	}
	return cmd
}

func TestShortNotes(t *testing.T) {
	body := "## [0.58.0](https://github.com/boson-chat/boson/compare/v0.57.3...v0.58.0) (2026-11-15)\n\n" +
		"### Features\n\n" +
		"* **desktop:** in-app updates ([#60](https://github.com/boson-chat/boson/issues/60)) ([abc1234](https://github.com/boson-chat/boson/commit/abc1234))\n" +
		"* see [the docs](https://boson.chat/docs) for `more`\n\n" +
		"### Bug Fixes\n\n" +
		"* one\n* two\n* three\n"
	got := ShortNotes(body, 3)
	want := "Features\n• desktop: in-app updates\n• see the docs for more\nBug Fixes\n• one\n…and 2 more"
	if got != want {
		t.Errorf("ShortNotes =\n%s\nwant\n%s", got, want)
	}
	if ShortNotes("", 5) != "" {
		t.Error("empty body")
	}
	// A heading whose entries are all cut doesn't dangle.
	if got := ShortNotes("### A\n* a\n### B\n* b\n", 1); got != "A\n• a\n…and 1 more" {
		t.Errorf("dangling heading: %q", got)
	}
}
