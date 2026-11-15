//go:build darwin

package selfupdate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A minimal real bundle, ad hoc signed: Info.plist + a copy of /usr/bin/true.
func signedBundle(t *testing.T, at, version string) {
	t.Helper()
	exe := filepath.Join(at, "Contents", "MacOS", "Boson")
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("/usr/bin/true")
	if err != nil {
		t.Skip(err)
	}
	os.WriteFile(exe, b, 0o755)
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Boson</string>
<key>CFBundleIdentifier</key><string>chat.boson.test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>` + version + `</string>
<key>CFBundleVersion</key><string>` + version + `</string>
</dict></plist>`
	os.WriteFile(filepath.Join(at, "Contents", "Info.plist"), []byte(plist), 0o644)
	if out, err := exec.Command("codesign", "--force", "--sign", "-", at).CombinedOutput(); err != nil {
		t.Skipf("codesign: %v %s", err, out)
	}
}

func zipBundle(t *testing.T, app, zip string) {
	t.Helper()
	if out, err := exec.Command("ditto", "-c", "-k", "--keepParent", app, zip).CombinedOutput(); err != nil {
		t.Fatalf("ditto: %v %s", err, out)
	}
}

func TestStageMacApp(t *testing.T) {
	apps := t.TempDir()
	target := filepath.Join(apps, "Boson.app")
	signedBundle(t, target, "1.0.0")

	build := t.TempDir()
	newApp := filepath.Join(build, "Boson.app")
	signedBundle(t, newApp, "1.1.0")
	zip := filepath.Join(build, "Boson-mac-arm64.app.zip")
	zipBundle(t, newApp, zip)
	// Quarantined, as a browser download would be: cleared on ours.
	exec.Command("xattr", "-w", "com.apple.quarantine", "0081;00000000;Test;", zip).Run()

	staged, err := StageMacApp(zip, target, "1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if staged != StagedPath(target) {
		t.Errorf("staged at %s", staged)
	}
	if out, _ := exec.Command("xattr", "-r", staged).CombinedOutput(); strings.Contains(string(out), "quarantine") {
		t.Errorf("quarantine left on the staged app: %s", out)
	}
	if err := Swap(target, staged); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("codesign", "--verify", "--strict", target).CombinedOutput(); err != nil {
		t.Errorf("signature broken by the swap: %s", out)
	}
	if out, _ := exec.Command("plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-",
		filepath.Join(target, "Contents", "Info.plist")).Output(); strings.TrimSpace(string(out)) != "1.1.0" {
		t.Errorf("installed version %q", out)
	}

	// The manifest says another version than the bundle: refused.
	if _, err := StageMacApp(zip, target, "1.2.0"); err == nil || !strings.Contains(err.Error(), "version") {
		t.Errorf("version mismatch: %v", err)
	}

	// Modified after signing: refused, and nothing is left staged.
	os.WriteFile(filepath.Join(newApp, "Contents", "Resources-extra"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(newApp, "Contents", "MacOS", "Boson"), []byte("#!/bin/sh\n"), 0o755)
	zip2 := filepath.Join(build, "tampered.zip")
	zipBundle(t, newApp, zip2)
	if _, err := StageMacApp(zip2, target, "1.1.0"); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Errorf("tampered bundle: %v", err)
	}
	if _, err := os.Stat(StagedPath(target)); !os.IsNotExist(err) {
		t.Error("a rejected bundle was left staged")
	}
}

// A real read-only volume: a disk image, as when Boson is opened straight
// from its DMG without being copied out.
func TestLocateReadOnlyVolume(t *testing.T) {
	if testing.Short() {
		t.Skip("mounts a disk image")
	}
	src := t.TempDir()
	fakeBundle(t, filepath.Join(src, "Boson.app"), "v1")
	dmg := filepath.Join(t.TempDir(), "ro.dmg")
	if out, err := exec.Command("hdiutil", "create", "-quiet", "-srcfolder", src, "-format", "UDZO", "-volname", "BosonRO", dmg).CombinedOutput(); err != nil {
		t.Skipf("hdiutil create: %v %s", err, out)
	}
	mnt := t.TempDir()
	if out, err := exec.Command("hdiutil", "attach", "-quiet", "-nobrowse", "-readonly", "-mountpoint", mnt, dmg).CombinedOutput(); err != nil {
		t.Skipf("hdiutil attach: %v %s", err, out)
	}
	t.Cleanup(func() { exec.Command("hdiutil", "detach", "-force", mnt).Run() })
	_, err := Locate("darwin", filepath.Join(mnt, "Boson.app", "Contents", "MacOS", "Boson"))
	ie, ok := IsInstallError(err)
	if !ok || ie.Reason != "read-only" || !strings.Contains(err.Error(), "move it to your Applications folder") {
		t.Fatalf("read-only volume: %v", err)
	}
}
