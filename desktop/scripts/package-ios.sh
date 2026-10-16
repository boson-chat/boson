#!/usr/bin/env bash
# Builds the app for iOS (Wails v3 mobile) as a simulator .app, and with
# RUN=1 installs and launches it in a booted (or newly booted) simulator:
#
#   client/out/renderer → desktop/frontend/dist
#     → go build -buildmode=c-archive (GOOS=ios) → bin/ios/Boson.a
#     → clang build/ios/main.m + Boson.a → bin/ios/Boson.app/Boson
#     → Info.plist (version from client/package.json), launch screen,
#       icons (actool) → ad-hoc codesign
#
# Environment:
#   DEV=1           a dev build: the renderer from client/.env (local
#                   backend + Supabase), devBuild=true, API proxy allowed to
#                   reach http://localhost:3000. The simulator shares the
#                   Mac's network, so localhost is the Mac.
#   RUN=1           install + launch in the simulator
#   SIMULATOR       simulator name or UDID (default: the booted one, else an
#                   iPhone on the newest installed iOS)
#   EXTRA_TAGS      more Go build tags (e.g. mcp: Wails' test harness)
#   SKIP_RENDERER=1 reuse client/out/renderer as it is
#
# Simulator only for now: device builds need an Apple Development identity
# and a provisioning profile (docs/mobile.md, Phase 4).
#
# Usage: desktop/scripts/package-ios.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
repo="$(dirname "$desktop")"
client="$repo/client"

if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

APP_NAME=Boson
MIN_IOS=16.0
SDK=iphonesimulator
TARGET="arm64-apple-ios$MIN_IOS-simulator"
SDK_PATH="$(xcrun --sdk "$SDK" --show-sdk-path)"
VERSION="$(cd "$client" && node -p "require('./package.json').version")"
out="$desktop/bin/ios"
app="$out/$APP_NAME.app"
mkdir -p "$out"

# 1. Renderer.
if [[ "${SKIP_RENDERER:-}" != "1" ]]; then
  if [[ "${DEV:-}" == "1" ]]; then
    (cd "$client" && npx vite build --mode development)
  else
    (cd "$client" && npm run build)
  fi
fi
[[ -f "$client/out/renderer/index.html" ]] || { echo "client/out/renderer is missing" >&2; exit 1; }
rm -rf "$desktop/frontend/dist"
cp -R "$client/out/renderer" "$desktop/frontend/dist"
touch "$desktop/frontend/dist/.gitkeep"

# 2. The Go app as a C archive.
tags=ios
ldflags="-X main.appVersion=$VERSION"
if [[ "${DEV:-}" == "1" ]]; then
  ldflags="$ldflags -X main.devBuild=true -X main.apiBase=http://localhost:3000"
else
  tags="$tags,production"
  ldflags="$ldflags -s -w"
fi
# EXTRA_TAGS: e.g. "mcp" — Wails' test harness on 127.0.0.1:9099, which the
# simulator shares with the Mac, to drive the page from scripts.
[[ -n "${EXTRA_TAGS:-}" ]] && tags="$tags,$EXTRA_TAGS"
echo "building the Go archive ($tags)"
(cd "$desktop" && GOOS=ios GOARCH=arm64 CGO_ENABLED=1 \
  CC="$(xcrun --sdk "$SDK" --find clang)" \
  CGO_CFLAGS="-isysroot $SDK_PATH -target $TARGET -mios-simulator-version-min=$MIN_IOS" \
  CGO_LDFLAGS="-isysroot $SDK_PATH -target $TARGET" \
  go build -buildmode=c-archive -tags "$tags" -trimpath -buildvcs=false -ldflags "$ldflags" -o "$out/$APP_NAME.a" .)

# 3. Link with the UIKit bootstrap. The entitlements go into the executable
#    (as Xcode does for the simulator): the Keychain needs an application
#    identifier, and codesigned entitlements make SpringBoard refuse
#    simulator apps.
rm -rf "$app"
mkdir -p "$app"
xcrun -sdk "$SDK" clang -target "$TARGET" -isysroot "$SDK_PATH" \
  -framework Foundation -framework UIKit -framework WebKit \
  -framework Security -framework CoreFoundation \
  -framework UniformTypeIdentifiers \
  -framework LocalAuthentication -framework UserNotifications \
  -framework AVFoundation \
  -framework CoreLocation -framework CoreMotion -framework SystemConfiguration \
  -lresolv \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements \
  -Xlinker "$desktop/build/ios/Simulator.entitlements" \
  -o "$app/$APP_NAME" \
  "$desktop/build/ios/main.m" -Wl,-force_load,"$out/$APP_NAME.a"

# 4. Bundle: Info.plist, launch screen, icons.
cp "$desktop/build/ios/Info.plist" "$app/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" -c "Set :CFBundleVersion $VERSION" "$app/Info.plist"
# Without a compiled launch screen iOS runs the app letterboxed, in its
# legacy screen-size compatibility mode.
xcrun ibtool --compile "$app/LaunchScreen.storyboardc" "$desktop/build/ios/LaunchScreen.storyboard"
ac="$(mktemp -d)"
trap 'rm -rf "$ac"' EXIT
xcrun actool --compile "$ac" --app-icon AppIcon --platform "$SDK" \
  --minimum-deployment-target "$MIN_IOS" --target-device iphone --target-device ipad \
  --output-partial-info-plist "$ac/partial.plist" "$desktop/build/ios/Assets.xcassets" >/dev/null
cp "$ac"/*.car "$app/" 2>/dev/null || true
cp "$ac"/*.png "$app/" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Merge $ac/partial.plist" "$app/Info.plist" >/dev/null
plutil -lint "$app/Info.plist" >/dev/null

# 5. Ad-hoc sign (the simulator accepts it; no entitlements on simulator builds).
codesign --force --sign - "$app"
echo "app: $app"

# 6. Run.
if [[ "${RUN:-}" == "1" ]]; then
  sim="${SIMULATOR:-}"
  if [[ -z "$sim" ]]; then
    sim="$(xcrun simctl list devices booted | grep -oE '[A-F0-9-]{36}' | head -1 || true)"
  fi
  if [[ -z "$sim" ]]; then
    # An iPhone on the newest installed iOS (DeviceHub only drives iOS 18+).
    runtime="$(xcrun simctl list runtimes | grep -oE '^iOS [0-9.]+' | sort -V | tail -1)"
    sim="$(xcrun simctl list devices available "$runtime" | grep -m1 'iPhone' | grep -oE '[A-F0-9-]{36}')"
  fi
  xcrun simctl boot "$sim" 2>/dev/null || true
  # Show it: Simulator.app, or DeviceHub.app in newer Xcodes. The simulator
  # runs without either.
  for viewer in "$DEVELOPER_DIR/Applications/Simulator.app" "$DEVELOPER_DIR/../Applications/DeviceHub.app"; do
    if [[ -d "$viewer" ]]; then open "$viewer" || true; break; fi
  done
  bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
  xcrun simctl terminate "$sim" "$bundle" 2>/dev/null || true
  xcrun simctl install "$sim" "$app"
  xcrun simctl launch "$sim" "$bundle"
fi
