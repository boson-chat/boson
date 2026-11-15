package selfupdate

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// StageMacApp unpacks a verified Boson-mac-<arch>.app.zip next to the
// running bundle (target) and checks the app inside before it may replace
// it:
//   - its Info.plist names the same bundle id and the manifest's version;
//   - its code signature is intact (codesign --verify --strict --deep);
//   - when the running app is Developer ID signed, the new one satisfies the
//     running app's designated requirement: same team, same identifier.
//
// Only then is the quarantine flag cleared — on our own download, already
// matched to the signed manifest. Returns the staged bundle (StagedPath).
func StageMacApp(zip, target, version string) (string, error) {
	stage, staged := StagePath(target), StagedPath(target)
	Cleanup(target)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	// ditto keeps the bundle exactly as signed (symlinks, modes, xattrs).
	if out, err := exec.Command("/usr/bin/ditto", "-x", "-k", zip, stage).CombinedOutput(); err != nil {
		return "", fmt.Errorf("selfupdate: unpacking the update: %v: %s", err, bytes.TrimSpace(out))
	}
	app := filepath.Join(stage, filepath.Base(target))
	if st, err := os.Stat(app); err != nil || !st.IsDir() {
		return "", fmt.Errorf("selfupdate: the update doesn't hold %s", filepath.Base(target))
	}
	if err := checkMacApp(app, target, version); err != nil {
		return "", err
	}
	exec.Command("/usr/bin/xattr", "-dr", "com.apple.quarantine", app).Run()
	if err := os.Rename(app, staged); err != nil {
		return "", err
	}
	return staged, nil
}

func checkMacApp(app, current, version string) error {
	plist := func(bundle, key string) string {
		out, _ := exec.Command("/usr/bin/plutil", "-extract", key, "raw", "-o", "-",
			filepath.Join(bundle, "Contents", "Info.plist")).Output()
		return strings.TrimSpace(string(out))
	}
	if v := plist(app, "CFBundleShortVersionString"); v != version {
		return fmt.Errorf("selfupdate: the update is version %q, not %s", v, version)
	}
	if id, want := plist(app, "CFBundleIdentifier"), plist(current, "CFBundleIdentifier"); id == "" || id != want {
		return fmt.Errorf("selfupdate: the update is %q, not %q", id, want)
	}
	if out, err := exec.Command("/usr/bin/codesign", "--verify", "--strict", "--deep", app).CombinedOutput(); err != nil {
		return fmt.Errorf("selfupdate: the update's code signature is invalid: %s", bytes.TrimSpace(out))
	}
	req := designatedRequirement(current)
	if req == "" {
		return nil // ad hoc (dev) build: nothing to pin to
	}
	if out, err := exec.Command("/usr/bin/codesign", "--verify", "--strict", "-R="+req, app).CombinedOutput(); err != nil {
		return fmt.Errorf("selfupdate: the update isn't signed by Boson's developer: %s", bytes.TrimSpace(out))
	}
	return nil
}

// designatedRequirement is a Developer ID signed bundle's designated
// requirement ("identifier … and anchor apple generic and … leaf[subject.OU]
// = TEAM"); empty for an ad hoc or unsigned one.
func designatedRequirement(bundle string) string {
	out, err := exec.Command("/usr/bin/codesign", "-d", "-r-", bundle).CombinedOutput()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if r, ok := strings.CutPrefix(strings.TrimSpace(line), "designated => "); ok {
			if strings.Contains(r, "anchor apple generic") {
				return r
			}
		}
	}
	return ""
}
