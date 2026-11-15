// Package selfupdate is the desktop app's in-place updater: it reads a
// release's ed25519-signed update manifest (update-manifest.json and its
// detached update-manifest.json.sig, written by .github/workflows/desktop.yml),
// downloads this platform's payload, checks it against the manifest (size,
// then sha256) and swaps it in for the running copy.
//
// Nothing here installs anything unsigned: a manifest is only trusted when
// its signature verifies against one of TrustedKeys, and a payload only when
// it matches that manifest byte for byte.
package selfupdate

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
)

// The update-signing public keys, base64 of the raw 32-byte ed25519 key.
//
// The private half of signingKey2026 is the UPDATE_SIGNING_KEY Actions
// secret on boson-chat/boson (backup: ~/.config/boson-signing/
// update-ed25519.pem on the release manager's machine).
//
// Rotating: generate the new pair, add its public key below (signingKey2027,
// say), ship a release with both, then switch the secret to the new private
// key. Drop the old public key once no supported version still needs it.
const signingKey2026 = "s+lldLPZ4p/pQJkwNcFlBBjitGc/xSCQTzaIioCtbZQ="

// trustedKeys: every key a manifest may be signed with. More than one only
// while rotating.
var trustedKeys = []string{signingKey2026}

// TrustedKeys returns the release keys (see signingKey2026).
func TrustedKeys() []ed25519.PublicKey {
	keys, err := ParseKeys(trustedKeys...)
	if err != nil {
		panic(err) // a typo in a constant above: fails every test run
	}
	return keys
}

// ParseKeys decodes base64 ed25519 public keys.
func ParseKeys(b64 ...string) ([]ed25519.PublicKey, error) {
	out := make([]ed25519.PublicKey, 0, len(b64))
	for _, s := range b64 {
		raw, err := base64.StdEncoding.DecodeString(s)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("selfupdate: bad ed25519 public key %q", s)
		}
		out = append(out, ed25519.PublicKey(raw))
	}
	return out, nil
}
