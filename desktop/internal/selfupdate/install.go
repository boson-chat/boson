package selfupdate

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// InstallError says why this copy can't replace itself, in words for the
// user (Settings → About shows it as is).
type InstallError struct {
	Reason string // "translocated" | "read-only" | "not-bundle" | "unsupported"
	Path   string
	msg    string
}

func (e *InstallError) Error() string { return e.msg }

// IsInstallError reports whether err is an InstallError (and which).
func IsInstallError(err error) (*InstallError, bool) {
	var ie *InstallError
	ok := errors.As(err, &ie)
	return ie, ok
}

// Locate finds what an update replaces for the running executable exe: the
// .app bundle on macOS, the executable itself on Windows and Linux. It fails
// with an InstallError when that can't be replaced in place: macOS running
// it translocated (straight from Downloads or a disk image) or from a
// read-only volume, or a folder this user can't write to.
func Locate(goos, exe string) (string, error) {
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	switch goos {
	case "darwin":
		macos := filepath.Dir(exe)
		contents := filepath.Dir(macos)
		bundle := filepath.Dir(contents)
		if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(bundle) != ".app" {
			return "", &InstallError{Reason: "not-bundle", Path: exe,
				msg: "This copy of Boson isn't an app bundle, so it can't update itself."}
		}
		if strings.Contains(filepath.ToSlash(bundle), "/AppTranslocation/") {
			return "", &InstallError{Reason: "translocated", Path: bundle,
				msg: "macOS is running Boson from a temporary read-only copy, so it can't update itself. " +
					"Quit Boson, move it to your Applications folder, and open it from there."}
		}
		if !writableDir(filepath.Dir(bundle)) {
			return "", &InstallError{Reason: "read-only", Path: bundle,
				msg: fmt.Sprintf("Boson is running from a read-only location (%s), so it can't update itself. "+
					"Quit Boson, move it to your Applications folder, and open it from there.", filepath.Dir(bundle))}
		}
		return bundle, nil
	case "windows", "linux":
		if !writableDir(filepath.Dir(exe)) {
			hint := "Update it the way you installed it, or download the new version from the release page."
			if goos == "windows" {
				hint = "Download the new version from the release page, or move the Boson folder somewhere you can write to."
			}
			return "", &InstallError{Reason: "read-only", Path: exe,
				msg: fmt.Sprintf("Boson is in a folder you can't write to (%s), so it can't update itself. %s", filepath.Dir(exe), hint)}
		}
		return exe, nil
	}
	return "", &InstallError{Reason: "unsupported", msg: "This platform doesn't update in place."}
}

// writableDir: whether a file can be created in dir (which also fails on a
// read-only volume).
func writableDir(dir string) bool {
	f, err := os.CreateTemp(dir, ".boson-write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

// Sibling paths of the target, in its own directory (so renames between
// them never cross a volume): the staged update, the copy it replaced, and
// scratch space for unpacking.
func StagedPath(target string) string { return sibling(target, "new") }
func BackupPath(target string) string { return sibling(target, "old") }
func StagePath(target string) string  { return sibling(target, "stage") }

func sibling(target, what string) string {
	return filepath.Join(filepath.Dir(target), "."+filepath.Base(target)+"."+what)
}

// Cleanup removes what an earlier update left beside target: a staged copy
// never applied, the copy an applied update replaced (which Windows won't
// let a running process delete), and scratch space.
func Cleanup(target string) {
	for _, p := range []string{StagedPath(target), BackupPath(target), StagePath(target)} {
		os.RemoveAll(p)
	}
}

// Swap puts staged (beside target: StagedPath) in target's place: target is
// renamed aside to BackupPath, then staged to target. If the second rename
// fails the first is undone, so target is never left missing. Running
// programs may be swapped: macOS and Linux keep the open inode, and Windows
// lets a running .exe be renamed (not deleted).
func Swap(target, staged string) error {
	if filepath.Dir(staged) != filepath.Dir(target) {
		return fmt.Errorf("selfupdate: %s isn't beside %s", staged, target)
	}
	if _, err := os.Lstat(staged); err != nil {
		return fmt.Errorf("selfupdate: no staged update: %w", err)
	}
	backup := BackupPath(target)
	if err := os.RemoveAll(backup); err != nil {
		return err
	}
	if err := os.Rename(target, backup); err != nil {
		return err
	}
	if err := os.Rename(staged, target); err != nil {
		if rerr := os.Rename(backup, target); rerr != nil {
			return fmt.Errorf("selfupdate: swap failed (%v) and restoring %s failed: %w", err, target, rerr)
		}
		return err
	}
	return nil
}
