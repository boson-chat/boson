#!/usr/bin/env bash
# Signs an update manifest: writes <manifest>.sig, the base64 ed25519
# signature over the manifest's exact bytes (what
# desktop/internal/selfupdate.VerifyManifest checks), and verifies it.
#
#   key       a PKCS#8 PEM ed25519 private key (in CI: the
#             UPDATE_SIGNING_KEY secret, written to a 0600 temp file)
#   manifest  update-manifest.json (scripts/update-manifest.py)
#
# REQUIRE_EMBEDDED_KEY=1 (CI) also fails unless the key's public half is one
# the app trusts (desktop/internal/selfupdate/keys.go): a release signed with
# any other key would be refused by every installed copy.
#
# Needs OpenSSL 3 (pkeyutl -rawin). Never prints the private key.
#
# Usage: desktop/scripts/sign-update-manifest.sh <key> <manifest>
set -euo pipefail

key="$1" manifest="$2"
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

openssl pkey -in "$key" -pubout -out "$tmp/pub.pem"
pub="$(openssl pkey -pubin -in "$tmp/pub.pem" -outform DER | tail -c 32 | base64 | tr -d '\n')"
if [[ "${REQUIRE_EMBEDDED_KEY:-0}" == 1 ]] && ! grep -qF "\"$pub\"" "$here/../internal/selfupdate/keys.go"; then
  echo "the signing key's public half ($pub) isn't in desktop/internal/selfupdate/keys.go" >&2
  exit 1
fi
openssl pkeyutl -sign -inkey "$key" -rawin -in "$manifest" -out "$tmp/sig.bin"
openssl pkeyutl -verify -pubin -inkey "$tmp/pub.pem" -rawin -in "$manifest" -sigfile "$tmp/sig.bin" >/dev/null
base64 < "$tmp/sig.bin" | tr -d '\n' > "$manifest.sig"
echo "signed $(basename "$manifest") with key $pub"
