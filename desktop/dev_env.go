package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
)

// devEnv is environment for dev builds, set at build time (-X main.devEnv=…,
// base64): what a desktop dev run gets from its shell, for builds that
// can't be given any (Android: an app has no environment of its own).
// desktop/scripts/package-android.sh DEV=1 sets it from DEV_ENV_FILE.
//
// One setting a line: KEY=value; or KEY@=<base64 of a file's contents> for
// settings that name a file (BOSON_NETWORK_JSON, BOSON_VOICE_JSON): the
// contents go to <dir>/dev-env/KEY and KEY is set to that path. Settings
// the process already has win.
var devEnv = ""

// applyDevEnv sets devEnv's settings (dev builds only), writing file
// settings under dir (the app's data directory).
func applyDevEnv(enc, dir string) error {
	if enc == "" {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		file := strings.HasSuffix(key, "@")
		key = strings.TrimSuffix(key, "@")
		if _, set := os.LookupEnv(key); set {
			continue
		}
		if file {
			body, err := base64.StdEncoding.DecodeString(val)
			if err != nil {
				return err
			}
			p := filepath.Join(dir, "dev-env", key)
			if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
				return err
			}
			if err := os.WriteFile(p, body, 0o600); err != nil {
				return err
			}
			val = p
		}
		os.Setenv(key, val)
	}
	return nil
}
