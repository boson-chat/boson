package selfupdate

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// The release assets the manifest and its signature are published as.
const (
	ManifestAsset  = "update-manifest.json"
	SignatureAsset = "update-manifest.json.sig"
	// MaxManifestSize caps what's read of either (a real one is ~1 KB).
	MaxManifestSize = 64 << 10
)

// Manifest is update-manifest.json: what a release ships for each platform.
// CI writes it (desktop/scripts/update-manifest.py) and signs its exact
// bytes; update-manifest.json.sig is the base64 ed25519 signature.
type Manifest struct {
	Schema  int    `json:"schema"`
	Version string `json:"version"`
	// MinVersion: the oldest version that may update to this one in place.
	// Older copies are sent to the release page instead.
	MinVersion string `json:"minVersion"`
	// Assets by platform: "darwin-arm64", "darwin-amd64", "windows-amd64",
	// "linux-amd64", "android-arm64" (PlatformKey).
	Assets map[string]Asset `json:"assets"`
}

// Asset is one platform's payload: a release asset's name, size and sha256.
type Asset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// PlatformKey names a platform in Manifest.Assets.
func PlatformKey(goos, goarch string) string { return goos + "-" + goarch }

var (
	ErrUnsigned     = errors.New("selfupdate: the update manifest isn't signed")
	ErrBadSignature = errors.New("selfupdate: the update manifest's signature doesn't verify")
	ErrBadManifest  = errors.New("selfupdate: the update manifest is malformed")
	ErrDowngrade    = errors.New("selfupdate: the update isn't newer than this version")
	ErrTooOld       = errors.New("selfupdate: this version is too old to update in place")
	ErrNoAsset      = errors.New("selfupdate: the update has nothing for this platform")
)

// VerifyManifest checks sig (base64 ed25519, as update-manifest.json.sig
// holds it) over the exact manifest bytes against keys, and only then parses
// them. Any failure is an error: there's no unsigned fallback here.
func VerifyManifest(manifest, sig []byte, keys []ed25519.PublicKey) (*Manifest, error) {
	sig = bytes.TrimSpace(sig)
	if len(sig) == 0 {
		return nil, ErrUnsigned
	}
	raw, err := base64.StdEncoding.DecodeString(string(sig))
	if err != nil || len(raw) != ed25519.SignatureSize {
		return nil, ErrBadSignature
	}
	if len(manifest) == 0 || len(manifest) > MaxManifestSize {
		return nil, ErrBadManifest
	}
	ok := false
	for _, k := range keys {
		if len(k) == ed25519.PublicKeySize && ed25519.Verify(k, manifest, raw) {
			ok = true
			break
		}
	}
	if !ok {
		return nil, ErrBadSignature
	}
	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(manifest))
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadManifest, err)
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

func (m *Manifest) validate() error {
	bad := func(why string) error { return fmt.Errorf("%w: %s", ErrBadManifest, why) }
	if m.Schema != 1 {
		return bad(fmt.Sprintf("schema %d", m.Schema))
	}
	if _, ok := ParseVersion(m.Version); !ok {
		return bad("version " + m.Version)
	}
	if m.MinVersion != "" {
		if _, ok := ParseVersion(m.MinVersion); !ok {
			return bad("minVersion " + m.MinVersion)
		}
	}
	for k, a := range m.Assets {
		if a.Name == "" || strings.ContainsAny(a.Name, `/\`) || strings.HasPrefix(a.Name, ".") {
			return bad(k + ": asset name")
		}
		if a.Size <= 0 {
			return bad(k + ": size")
		}
		if b, err := hex.DecodeString(a.SHA256); err != nil || len(b) != 32 {
			return bad(k + ": sha256")
		}
	}
	return nil
}

// For picks the payload this copy (version current, on platform) installs:
// the manifest must be newer (ErrDowngrade), current no older than its
// minimum (ErrTooOld), and the platform listed (ErrNoAsset).
func (m *Manifest) For(current, platform string) (Asset, error) {
	if !Newer(m.Version, current) {
		return Asset{}, ErrDowngrade
	}
	if m.MinVersion != "" {
		if c, ok := Compare(current, m.MinVersion); !ok || c < 0 {
			return Asset{}, ErrTooOld
		}
	}
	a, ok := m.Assets[platform]
	if !ok {
		return Asset{}, ErrNoAsset
	}
	return a, nil
}
