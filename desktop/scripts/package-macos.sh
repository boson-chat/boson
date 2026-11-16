#!/usr/bin/env bash
# Builds the Wails desktop app as signed (and optionally notarized) macOS
# bundles and DMGs, one per architecture (Apple Silicon, Intel):
#
#   client/out/renderer (npm run build, production env)
#     → desktop/frontend/dist → per arch: binary
#     → bin/mac-<arch>/<APP_NAME>.app → codesign (hardened runtime)
#     → notarytool + stapler (with notary credentials, below)
#     → bin/<APP_NAME>-<version>-mac-<arch>.dmg (signed, notarized)
#     → bin/<APP_NAME>-<version>-mac-<arch>.app.zip (the same stapled app:
#       the in-app updater's payload, desktop/internal/selfupdate)
#
# <arch> is arm64 (Apple Silicon) or x64 (Intel).
#
# Environment:
#   APP_NAME        bundle name (default "Boson")
#   BUNDLE_ID       CFBundleIdentifier (default chat.boson.app)
#   SIGN_IDENTITY   codesign identity (default: the keychain's Developer ID
#                   Application identity; "-" signs ad hoc)
#   NOTARY_PROFILE  notarytool keychain profile (xcrun notarytool
#                   store-credentials), or, as CI passes them:
#   APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
#                   App Store Connect API key (.p8 path), its id and the
#                   issuer. Neither set skips notarization.
#   ARCHS           which to build (default "arm64 x64")
#   SKIP_RENDERER=1 reuse client/out/renderer as it is
#   OPUS_PREFIX     where the static libopus per arch is built/cached
#                   (default desktop/build/.opus; scripts/build-opus.sh)
#   BOSON_VERSION   the version to build as (default client/package.json's;
#                   scripts/e2e-update-macos.sh builds two)
#   EXTRA_LDFLAGS   more go -ldflags (e.g. -X main.devBuild=true)
#
# Usage: desktop/scripts/package-macos.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
repo="$(dirname "$desktop")"
client="$repo/client"

APP_NAME="${APP_NAME:-Boson}"
BUNDLE_ID="${BUNDLE_ID:-chat.boson.app}"
VERSION="${BOSON_VERSION:-$(node -p "require('$client/package.json').version")}"
if [[ -z "${SIGN_IDENTITY:-}" ]]; then
  SIGN_IDENTITY="$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ { print $2; exit }')"
  [[ -n "$SIGN_IDENTITY" ]] || { echo "no Developer ID Application identity in the keychain (set SIGN_IDENTITY=- for ad hoc)" >&2; exit 1; }
fi

# cgo against the macOS SDK: Xcode's toolchain when installed (the Command
# Line Tools' linker can lag the SDK), and the same minimum as the Taskfile.
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
export CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=12.0
export CGO_CFLAGS="-mmacosx-version-min=12.0" CGO_LDFLAGS="-mmacosx-version-min=12.0"

out="$desktop/bin"
mkdir -p "$out"
# Voice: libopus, statically linked, one build per architecture.
OPUS_PREFIX="${OPUS_PREFIX:-$desktop/build/.opus}"

# 1. Renderer: the production bundle (client/.env.production).
if [[ "${SKIP_RENDERER:-}" != "1" ]]; then
  (cd "$client" && npm run build)
fi
[[ -f "$client/out/renderer/index.html" ]] || { echo "client/out/renderer is missing" >&2; exit 1; }
rm -rf "$desktop/frontend/dist"
cp -R "$client/out/renderer" "$desktop/frontend/dist"
touch "$desktop/frontend/dist/.gitkeep"

ldflags="-s -w -X main.appVersion=$VERSION${EXTRA_LDFLAGS:+ $EXTRA_LDFLAGS}"
# Another YouTube wrapper origin (default https://boson.chat; a PR's website
# preview to try changes to it). Unset: the build's default.
[[ -n "${YOUTUBE_WRAPPER:-}" ]] && ldflags="$ldflags -X main.youtubeWrapperOrigin=$YOUTUBE_WRAPPER"
# The default network directory the API proxy may fully reach; keep it the
# same as the renderer's VITE_DIRECTORY_URL. Unset: https://directory.boson.chat.
[[ -n "${VITE_DIRECTORY_URL:-}" ]] && ldflags="$ldflags -X main.directoryBase=$VITE_DIRECTORY_URL"

notary=()
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  notary=(--keychain-profile "$NOTARY_PROFILE")
elif [[ -n "${APPLE_API_KEY:-}" ]]; then
  notary=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
fi

# Runs "$@", killing it after $1 seconds (macOS has no coreutils timeout).
with_timeout() {
  local secs="$1"; shift
  perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$secs" "$@"
}

# Apple's notary service sometimes hangs before or during the upload with no
# error (seen in CI: 37 minutes at "initiating connection"). Cap each attempt
# (NOTARY_ATTEMPT_SECONDS, default 600) and retry (NOTARY_ATTEMPTS, default 3).
notarize() {
  local attempt max="${NOTARY_ATTEMPTS:-3}" secs="${NOTARY_ATTEMPT_SECONDS:-600}"
  for ((attempt = 1; attempt <= max; attempt++)); do
    if with_timeout "$secs" xcrun notarytool submit "$1" "${notary[@]}" --wait --timeout "$((secs - 30))s"; then
      xcrun stapler staple "$2"
      xcrun stapler validate "$2"
      return 0
    fi
    echo "notarytool attempt $attempt/$max for $(basename "$1") failed or timed out" >&2
    sleep $((attempt * 15))
  done
  echo "notarization of $(basename "$1") failed after $max attempts" >&2
  return 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# One architecture: binary → bundle → sign → notarize → DMG.
package() {
  local arch="$1" goarch
  case "$arch" in
    arm64) goarch=arm64 ;;
    x64) goarch=amd64 ;;
    *) echo "unknown arch $arch (arm64 or x64)" >&2; exit 1 ;;
  esac
  local app="$out/mac-$arch/$APP_NAME.app"
  local dmg="$out/$APP_NAME-$VERSION-mac-$arch.dmg"
  local appzip="$out/$APP_NAME-$VERSION-mac-$arch.app.zip"

  # 2. Binary: production build (no devtools), with voice: libopus for
  #    this architecture (static; nolibopusfile: only libopus is used).
  echo "building $arch"
  local opus_arch="$arch"
  [[ "$arch" == x64 ]] && opus_arch=x86_64
  "$here/build-opus.sh" "$OPUS_PREFIX/$opus_arch" "$opus_arch"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  # The prefix in CGO_CFLAGS too: Go's build cache doesn't key on
  # PKG_CONFIG_PATH, and would reuse a build against another libopus.
  (cd "$desktop" && GOARCH="$goarch" PKG_CONFIG_PATH="$OPUS_PREFIX/$opus_arch/lib/pkgconfig" \
    CGO_CFLAGS="$CGO_CFLAGS -I$OPUS_PREFIX/$opus_arch/include" \
    go build -tags production,nolibopusfile -trimpath -buildvcs=false \
    -ldflags "$ldflags" -o "$app/Contents/MacOS/$APP_NAME" .)
  lipo -archs "$app/Contents/MacOS/$APP_NAME"
  # libopus is linked in, not loaded from the user's system.
  if otool -L "$app/Contents/MacOS/$APP_NAME" | grep -qi opus; then
    echo "the binary links a shared libopus" >&2
    exit 1
  fi

  # 3. Bundle.
  cp "$desktop/build/darwin/icons.icns" "$app/Contents/Resources/icons.icns"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>icons</string>
  <key>LSMinimumSystemVersion</key><string>12.0.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.social-networking</string>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Boson</string>
  <key>NSMicrophoneUsageDescription</key><string>Boson uses your microphone when you join a voice channel or test your mic.</string>
  <key>NSCameraUsageDescription</key><string>Boson uses your camera when you turn it on in a call, so the others in the channel can see you.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>Boson Chat Deep Link</string>
      <key>CFBundleURLSchemes</key><array><string>boson</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
  plutil -lint "$app/Contents/Info.plist" >/dev/null
  # Every privacy usage string in build/darwin/Info.plist must be in the
  # packaged plist too: macOS kills the app (SIGABRT) the moment it asks for
  # the camera or microphone without one (boson 0.65-0.69 crashed turning
  # the camera on because this heredoc lacked NSCameraUsageDescription).
  local key missing=0
  for key in $(grep -o 'NS[A-Za-z]*UsageDescription' "$desktop/build/darwin/Info.plist" | sort -u); do
    if ! /usr/libexec/PlistBuddy -c "Print :$key" "$app/Contents/Info.plist" >/dev/null 2>&1; then
      echo "package-macos: $key is in build/darwin/Info.plist but not in the packaged Info.plist" >&2
      missing=1
    fi
  done
  [[ $missing == 0 ]] || exit 1

  # 4. Sign: hardened runtime + secure timestamp (both required to notarize).
  #    Entitlements: the microphone (voice), which the hardened runtime
  #    otherwise refuses.
  local entitlements="$desktop/build/darwin/entitlements.plist"
  if [[ "$SIGN_IDENTITY" == "-" ]]; then
    codesign --force --entitlements "$entitlements" --sign - "$app"
  else
    codesign --force --options runtime --timestamp --entitlements "$entitlements" --sign "$SIGN_IDENTITY" "$app"
  fi
  codesign --verify --strict --verbose=2 "$app"

  # 5. Notarize the app itself, so a copy taken out of the DMG is stapled too.
  if [[ ${#notary[@]} -gt 0 ]]; then
    local zip="$work/$APP_NAME-$arch-notarize.zip"
    rm -f "$zip"
    ditto -c -k --keepParent "$app" "$zip"
    notarize "$zip" "$app"
    rm -f "$zip"
    spctl --assess --type execute --verbose=4 "$app"
  fi

  # 6. The in-app update payload: the signed, stapled bundle as it is
  #    (ditto keeps its signature, symlinks and modes).
  rm -f "$appzip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$appzip"

  # 7. DMG: the app plus an Applications link to drag it onto.
  local stage="$work/stage-$arch"
  rm -rf "$stage" && mkdir -p "$stage"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  rm -f "$dmg"
  hdiutil create -quiet -volname "$APP_NAME $VERSION" -srcfolder "$stage" -fs APFS -format UDZO "$dmg"
  if [[ "$SIGN_IDENTITY" != "-" ]]; then
    codesign --force --timestamp --sign "$SIGN_IDENTITY" "$dmg"
  fi
  if [[ ${#notary[@]} -gt 0 ]]; then
    notarize "$dmg" "$dmg"
  fi

  echo "app: $app"
  echo "dmg: $dmg"
  echo "update payload: $appzip"
}

# Architectures build, sign and notarize in parallel (each in its own
# subshell, output prefixed with the arch); notarization waits dominate.
# PARALLEL=0 builds them one after another.
pids=() archs=()
for arch in ${ARCHS:-arm64 x64}; do
  if [[ "${PARALLEL:-1}" == 0 ]]; then
    package "$arch"
    continue
  fi
  ( set -o pipefail; package "$arch" 2>&1 | sed -u "s/^/[$arch] /" ) &
  pids+=("$!") archs+=("$arch")
done
failed=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "packaging ${archs[$i]} failed" >&2
    failed=1
  fi
done
exit "$failed"
