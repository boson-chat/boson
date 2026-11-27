#!/usr/bin/env bash
# The Android push receiver's plain-Java core (decryption, IRC line parsing,
# the notification filter) on the desktop JDK: no Android SDK or device.
#
# Usage: desktop/scripts/test-android-push.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
app="$desktop/build/android/app/src"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
javac -d "$out" \
  "$app/main/java/com/wails/app/PushCrypto.java" \
  "$app/main/java/com/wails/app/PushLine.java" \
  "$app/main/java/com/wails/app/PushFilter.java" \
  "$app/test/java/com/wails/app/PushCoreTest.java"
java -cp "$out" com.wails.app.PushCoreTest "$desktop/testdata/webpush-ergo-vector.json"
