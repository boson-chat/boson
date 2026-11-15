#!/usr/bin/env bash
# End-to-end check of the in-app updater on macOS with real builds:
#
#   1. builds Boson OLD_VERSION and NEW_VERSION (default 0.0.1, 0.0.2) as
#      dev builds (-X main.devBuild=true; ad hoc signed, not notarized) with
#      package-macos.sh, for this Mac's architecture;
#   2. installs OLD in a scratch "Applications" folder, with a scratch
#      profile (BOSON_DATA_DIR) holding a marker file;
#   3. serves a GitHub-shaped release feed on 127.0.0.1 for NEW: the .app.zip
#      payload, update-manifest.json and its signature with a throwaway test
#      key (never the release key);
#   4. starts OLD pointed at that feed (BOSON_UPDATE_FEED, BOSON_UPDATE_TEST_KEY
#      — dev builds only) with BOSON_UPDATE_AUTOAPPLY=1 standing in for the
#      clicks on "Update" and "Restart to update";
#   5. waits for the relaunched NEW to start, then checks: the bundle is NEW
#      and its signature intact, the old process is gone, the new one runs
#      from the same place with the same profile (marker still there), and
#      the replaced bundle was cleaned up.
#
# Needs Xcode's command line tools, Go, Node (the renderer build), Python 3
# and OpenSSL 3 (Homebrew's).
#
# Usage: desktop/scripts/e2e-update-macos.sh   (SKIP_RENDERER=1 reuses
#        client/out/renderer; KEEP=1 keeps the scratch folder)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
OLD="${OLD_VERSION:-0.0.1}"
NEW="${NEW_VERSION:-0.0.2}"
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
esac
openssl_bin="$(command -v /opt/homebrew/bin/openssl || command -v /usr/local/bin/openssl || command -v openssl)"
export PATH="$(dirname "$openssl_bin"):$PATH"

# Its own bundle id, so LaunchServices never mistakes these builds for an
# installed Boson (they're unregistered again at the end). Dev builds take
# their own single-instance lock too, so a running Boson doesn't matter.
export BUNDLE_ID=chat.boson.e2e-update
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

tmp="${TMPDIR:-/tmp}"
work="$(cd "$(mktemp -d "${tmp%/}/boson-e2e-update.XXXXXX")" && pwd -P)"
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  pkill -f "$work/Applications/Boson.app/Contents/MacOS/Boson" 2>/dev/null || true
  [[ -n "${new_pid:-}" ]] && kill "$new_pid" 2>/dev/null || true
  for app in "$work"/Applications/Boson.app "$work"/build-*/Boson.app "$desktop/bin/mac-$arch/Boson.app"; do
    [[ -d "$app" ]] && "$lsregister" -u "$app" 2>/dev/null || true
  done
  if [[ "${KEEP:-}" == 1 ]]; then echo "kept $work"; else rm -rf "$work"; fi
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "--- start log"; cat "$work/starts.log" 2>/dev/null || true; echo "--- app log"; tail -40 "$work/app.log" 2>/dev/null || true; exit 1; }

# 1. Builds (NEW first, so OLD is what's left in bin/).
skip="${SKIP_RENDERER:-0}"
for v in "$NEW" "$OLD"; do
  echo "== building $v"
  SIGN_IDENTITY=- ARCHS="$arch" PARALLEL=0 BOSON_VERSION="$v" SKIP_RENDERER="$skip" \
    EXTRA_LDFLAGS="-X main.devBuild=true" "$here/package-macos.sh" >"$work/build-$v.log" 2>&1 \
    || { tail -30 "$work/build-$v.log"; fail "build $v"; }
  skip=1
  mkdir -p "$work/build-$v"
  ditto "$desktop/bin/mac-$arch/Boson.app" "$work/build-$v/Boson.app"
  cp "$desktop/bin/Boson-$v-mac-$arch.app.zip" "$work/build-$v/"
done

# 2. Install OLD; a profile with something in it.
mkdir -p "$work/Applications" "$work/profile"
ditto "$work/build-$OLD/Boson.app" "$work/Applications/Boson.app"
echo "session" > "$work/profile/session-marker"

# 3. The feed.
feed="$work/feed"
mkdir -p "$feed"
cp "$work/build-$NEW/Boson-$NEW-mac-$arch.app.zip" "$feed/Boson-mac-$arch.app.zip"
openssl genpkey -algorithm ed25519 -out "$work/test-key.pem"
"$here/update-manifest.py" "$feed" "$NEW" 0.0.0 >"$feed/update-manifest.json" 2>/dev/null
"$here/sign-update-manifest.sh" "$work/test-key.pem" "$feed/update-manifest.json"
pub="$(openssl pkey -in "$work/test-key.pem" -pubout -outform DER | tail -c 32 | base64)"
port="$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
python3 -I - "$feed" "$port" "$NEW" <<'PY'
import json, os, sys
feed, port, version = sys.argv[1], sys.argv[2], sys.argv[3]
assets = [{"name": n, "size": os.path.getsize(os.path.join(feed, n)),
           "browser_download_url": f"http://127.0.0.1:{port}/{n}"} for n in sorted(os.listdir(feed))]
json.dump({"tag_name": "v" + version, "html_url": f"http://127.0.0.1:{port}/",
           "body": f"## {version}\n\n### Features\n\n* the e2e update\n", "assets": assets},
          open(os.path.join(feed, "latest"), "w"))
PY
python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$feed" >"$work/feed.log" 2>&1 &
pids+=("$!")

# 4. Start OLD.
echo "== starting $OLD against http://127.0.0.1:$port/latest"
BOSON_DATA_DIR="$work/profile" BOSON_SECURE_STORE=derived \
BOSON_UPDATE_FEED="http://127.0.0.1:$port/latest" BOSON_UPDATE_TEST_KEY="$pub" \
BOSON_UPDATE_AUTOAPPLY=1 BOSON_START_LOG="$work/starts.log" \
  "$work/Applications/Boson.app/Contents/MacOS/Boson" >"$work/app.log" 2>&1 &
old_pid=$!
pids+=("$old_pid")

# 5. Wait for NEW (first check after 10 s, then the download and relaunch).
for _ in $(seq 1 120); do
  grep -q "^started $NEW " "$work/starts.log" 2>/dev/null && break
  sleep 1
done
grep -q "^started $OLD pid=$old_pid " "$work/starts.log" || fail "$OLD didn't log its start"
line="$(grep "^started $NEW " "$work/starts.log" || true)"
[[ -n "$line" ]] || fail "$NEW never started"
new_pid="$(sed -E 's/.* pid=([0-9]+) .*/\1/' <<<"$line")"
sleep 2
echo "$line"

installed="$(plutil -extract CFBundleShortVersionString raw -o - "$work/Applications/Boson.app/Contents/Info.plist")"
[[ "$installed" == "$NEW" ]] || fail "the installed bundle is $installed"
codesign --verify --strict --deep "$work/Applications/Boson.app" || fail "the installed bundle's signature is broken"
! kill -0 "$old_pid" 2>/dev/null || fail "the old copy ($old_pid) is still running"
kill -0 "$new_pid" 2>/dev/null || fail "the new copy ($new_pid) isn't running"
[[ "$(ps -o comm= -p "$new_pid")" == "$work/Applications/Boson.app/Contents/MacOS/Boson" ]] \
  || fail "the new copy runs from $(ps -o comm= -p "$new_pid")"
grep -q "data=$work/profile " <<<"$line" || fail "the new copy uses another profile"
[[ -f "$work/profile/session-marker" ]] || fail "the profile lost its data"
[[ ! -e "$work/Applications/.Boson.app.old" ]] || fail "the replaced bundle was left behind"
[[ ! -e "$work/Applications/.Boson.app.new" ]] || fail "a staged bundle was left behind"
grep -q "GET /Boson-mac-$arch.app.zip" "$work/feed.log" || fail "the payload was never downloaded"
echo "PASS: $OLD updated itself to $NEW in place and relaunched (pid $old_pid → $new_pid)"
