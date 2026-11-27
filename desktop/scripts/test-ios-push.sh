#!/usr/bin/env bash
# Runs the iOS Notification Service Extension's tests on the Mac (its
# decrypt, parsing and filtering; build/ios/push/tests/main.swift).
set -euo pipefail
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
desktop="$(cd "$(dirname "$0")/.." && pwd)"
push="$desktop/build/ios/push"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
xcrun swiftc -O -o "$out/push-tests" "$push/PushCrypto.swift" "$push/PushLine.swift" "$push/NotificationService.swift" "$push/tests/main.swift"
"$out/push-tests" "$desktop/testdata/webpush-ergo-vector.json"
