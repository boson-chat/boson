#!/usr/bin/env bash
# The Android real-call camera test: the app on an emulator joins a voice
# channel and turns its camera on, and desktop/cmd/callprobe, a second
# participant on this machine, checks the camera arrives as real video
# (pictures decoded, fps, size, not blank). The spec drives the app's
# WebView with Playwright: client/tests/android-call/call.spec.ts.
#
# Local (default): needs the e2e stack up (client/scripts/e2e-stack.mjs
# up: its auth for the app's sign-in, auth2 + ergo2 as a self-hosted
# network) and quicvoice + quicvideo checkouts next to this repo. This
# script builds and starts quicvoiced (AUTH_INSECURE, video tickets) and
# quicvideod on the 27xxx ports, builds a dev APK pointed at all of it
# (10.0.2.2 is the host as the emulator sees it), boots the AVD read-only
# (nothing it does is kept), and runs the test. Accounts are throwaway
# ones on the stack's tmpfs auth services.
#
# Production: set ANDROID_CALL_USER / ANDROID_CALL_PASSWORD (a test account
# on auth.boson.chat), ANDROID_CALL_SERVER (its server card),
# ANDROID_CALL_VOICE (the voice channel's name), PROBE_VOICE (quicvoiced's
# host:port), PROBE_ROOM (the channel's id) and PROBE_TOKEN (a voice token
# for the same account, which quicvoice lets join from two devices). The
# APK is then a normal dev build against production.
#
# Environment: AVD (default "boson", an arm64 image with an emulated back
# camera), ARCHS (default arm64), KEEP=1 leaves the emulator and servers
# running, SKIP_BUILD=1 reuses the last APK.
#
# Usage: desktop/scripts/android-call-test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
repo="$(dirname "$desktop")"
client="$repo/client"
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
adb="$sdk/platform-tools/adb"
work="${WORK:-$(mktemp -d -t android-call)}"
avd="${AVD:-boson}"
prod="${ANDROID_CALL_USER:-}"
pids=()
cleanup() {
  [[ "${KEEP:-}" == "1" ]] && return
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  "$adb" emu kill >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Servers (local only).
if [[ -z "$prod" ]]; then
  src="${QUICVOICE_SRC:-$repo/../quicvoice}"
  vsrc="${QUICVIDEO_SRC:-$repo/../quicvideo}"
  (cd "$src" && go build -o "$work/quicvoiced" ./server/cmd)
  (cd "$vsrc" && go build -o "$work/quicvideod" ./server/cmd)
  env QUIC_ADDR=127.0.0.1:27700 HTTP_ADDR=127.0.0.1:27780 PUBLIC_HTTP_ADDR=127.0.0.1:27790 AUTH_INSECURE=true \
    VOICE_ROOMS=general:General VIDEO_QUIC_URL=quic://10.0.2.2:27710 VIDEO_TICKET_KEY_FILE="$work/video-ticket.key" \
    "$work/quicvoiced" serve > "$work/voice.log" 2>&1 &
  pids+=($!)
  sleep 2
  env QUIC_ADDR=127.0.0.1:27710 HTTP_ADDR=127.0.0.1:27781 PUBLIC_HTTP_ADDR=127.0.0.1:27791 \
    AUTH_JWKS_URL=http://127.0.0.1:27790/.well-known/video-jwks.json AUTH_ISSUER=voice \
    "$work/quicvideod" serve > "$work/video.log" 2>&1 &
  pids+=($!)
fi
(cd "$desktop" && go build -tags nolibopusfile -o "$work/callprobe" ./cmd/callprobe)

# 2. The dev APK.
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  if [[ -z "$prod" ]]; then
    net='{"version":1,"irc":{"host":"10.0.2.2","port":16668,"tls":false},"auth":{"url":"http://10.0.2.2:18181"},"voice":{"addr":"10.0.2.2:27700","url":"http://10.0.2.2:27790"}}'
    printf 'BOSON_NETWORK_JSON@=%s\n' "$(printf '%s' "$net" | base64 | tr -d '\n')" > "$work/dev.env"
    VITE_AUTH_URL=http://10.0.2.2:18180 VITE_BOSON_API_URL=http://10.0.2.2:13000 VITE_DIRECTORY_URL=http://10.0.2.2:18480 \
      DEV=1 DEV_API_BASE=http://10.0.2.2:13000 DEV_AUTH_BASE=http://10.0.2.2:18180 DEV_DIRECTORY_BASE=http://10.0.2.2:18480 \
      DEV_ENV_FILE="$work/dev.env" ARCHS="${ARCHS:-arm64}" bash "$here/package-android.sh"
  else
    DEV=1 DEV_API_BASE=https://api.boson.chat ARCHS="${ARCHS:-arm64}" bash "$here/package-android.sh"
  fi
fi
apk="$(ls -t "$desktop"/bin/android/*.apk | head -1)"

# 3. The emulator: read-only, so the AVD's own data stays as it was.
"$sdk/emulator/emulator" -avd "$avd" -read-only -no-window -no-audio -no-boot-anim -no-snapshot \
  -camera-back emulated -gpu swiftshader_indirect > "$work/emulator.log" 2>&1 &
"$adb" wait-for-device
for _ in $(seq 1 100); do [[ "$("$adb" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]] && break; sleep 3; done
"$adb" install -r "$apk" >/dev/null
"$adb" shell pm clear chat.boson.app >/dev/null
for p in CAMERA RECORD_AUDIO POST_NOTIFICATIONS; do "$adb" shell pm grant chat.boson.app "android.permission.$p"; done
# The first start after a clear sets the app up and exits; the second stays.
"$adb" shell am start -W -n chat.boson.app/com.wails.app.MainActivity >/dev/null; sleep 3
"$adb" shell am start -W -n chat.boson.app/com.wails.app.MainActivity >/dev/null; sleep 8

# 4. The test.
if [[ -z "$prod" ]]; then
  probe_args="-voice 127.0.0.1:27700 -insecure -token probe -video 127.0.0.1:27710 -skip cam -wait 60s -for 10s"
  # Someone else's camera, for the phone to show.
  publish_args="-voice 127.0.0.1:27700 -insecure -token cam -video 127.0.0.1:27710 -publish -for 60s"
else
  probe_args="-voice ${PROBE_VOICE:?} -room ${PROBE_ROOM:?} -token ${PROBE_TOKEN:?} -wait 90s -for 10s"
fi
mkdir -p "$work/shots"
(cd "$client" && CALLPROBE="$work/callprobe" CALLPROBE_ARGS="$probe_args" CALLPROBE_PUBLISH_ARGS="${publish_args:-}" ANDROID_CALL_SHOTS="$work/shots" \
  npx playwright test -c tests/android-call/playwright.config.ts)
echo "screenshots and logs: $work"
