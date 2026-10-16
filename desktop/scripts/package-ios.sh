#!/usr/bin/env bash
# Builds the app for iOS (Wails v3 mobile) as a simulator .app — or, with
# IOS_PLATFORM=device, a development-signed .app for a registered iPhone —
# and with RUN=1 installs and launches it:
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
#   IOS_PLATFORM    simulator (default) or device. A device build signs with
#                   an Apple Development identity and a development profile
#                   covering the device: Xcode's team profile when Xcode
#                   manages one (sign in to Xcode, then run any automatic-
#                   signing build for the device once), else one that
#                   scripts/ios_provision.py makes through the App Store
#                   Connect API (APPLE_API_KEY, APPLE_API_KEY_ID,
#                   APPLE_API_ISSUER; needs an Admin or App Manager key).
#   PROVISIONING_PROFILE / CODESIGN_IDENTITY  use these instead
#   DEVICE_ID       the iPhone's UDID (default: the first connected one)
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
PLATFORM="${IOS_PLATFORM:-simulator}"
if [[ "$PLATFORM" == "device" ]]; then
  SDK=iphoneos
  TARGET="arm64-apple-ios$MIN_IOS"
  VERSION_MIN="-miphoneos-version-min=$MIN_IOS"
else
  SDK=iphonesimulator
  TARGET="arm64-apple-ios$MIN_IOS-simulator"
  VERSION_MIN="-mios-simulator-version-min=$MIN_IOS"
fi
SDK_PATH="$(xcrun --sdk "$SDK" --show-sdk-path)"
VERSION="$(cd "$client" && node -p "require('./package.json').version")"
out="$desktop/bin/ios-$PLATFORM"
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
  CGO_CFLAGS="-isysroot $SDK_PATH -target $TARGET $VERSION_MIN" \
  CGO_LDFLAGS="-isysroot $SDK_PATH -target $TARGET" \
  go build -buildmode=c-archive -tags "$tags" -trimpath -buildvcs=false -ldflags "$ldflags" -o "$out/$APP_NAME.a" .)

# 3. Link with the UIKit bootstrap. Simulator builds carry their
#    entitlements in the executable (as Xcode does): the Keychain needs an
#    application identifier, and codesigned entitlements make SpringBoard
#    refuse simulator apps. Device builds get theirs at signing (step 5).
sim_entitlements=()
if [[ "$PLATFORM" != "device" ]]; then
  sim_entitlements=(-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements
    -Xlinker "$desktop/build/ios/Simulator.entitlements")
fi
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
  ${sim_entitlements[@]+"${sim_entitlements[@]}"} \
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

# 5. Sign. Simulator: ad hoc. Device: the development identity, with the
#    profile embedded and the matching entitlements.
if [[ "$PLATFORM" == "device" ]]; then
  if [[ -z "${DEVICE_ID:-}" ]]; then
    DEVICE_ID="$(xcrun devicectl list devices --hide-headers 2>/dev/null | awk '/physical/ { for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')"
  fi
  [[ -n "${DEVICE_ID:-}" ]] || { echo "no iPhone connected (or pass DEVICE_ID=<UDID>)" >&2; exit 1; }
  profile="${PROVISIONING_PROFILE:-}"
  identity="${CODESIGN_IDENTITY:-}"
  if [[ -z "$profile" ]]; then
    # An Xcode-managed profile for our team that includes this device.
    team="$(/usr/libexec/PlistBuddy -c 'Print :application-identifier' "$desktop/build/ios/Device.entitlements" | cut -d. -f1)"
    for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision; do
      [[ -f "$f" ]] || continue
      plist="$(security cms -D -i "$f" 2>/dev/null)" || continue
      appid="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' /dev/stdin <<<"$plist" 2>/dev/null || true)"
      if [[ ( "$appid" == "$team.*" || "$appid" == "$team.chat.boson.app" ) && "$plist" == *"$DEVICE_ID"* ]]; then
        profile="$f"
        break
      fi
    done
  fi
  if [[ -n "$profile" && -z "$identity" ]]; then
    identity="$(security find-identity -v -p codesigning | awk '/Apple Development/ { print $2; exit }')"
  fi
  if [[ -z "$profile" || -z "$identity" ]]; then
    identity="$(python3 "$here/ios_provision.py" --udid "$DEVICE_ID" --out "$out/development.mobileprovision")"
    profile="$out/development.mobileprovision"
  fi
  cp "$profile" "$app/embedded.mobileprovision"
  codesign --force --sign "$identity" --entitlements "$desktop/build/ios/Device.entitlements" --timestamp=none "$app"
else
  codesign --force --sign - "$app"
fi
codesign --verify --verbose=1 "$app"
echo "app: $app"

# 6. Run.
if [[ "${RUN:-}" == "1" && "$PLATFORM" == "device" ]]; then
  bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
  xcrun devicectl device install app --device "$DEVICE_ID" "$app"
  xcrun devicectl device process launch --device "$DEVICE_ID" --terminate-existing "$bundle"
elif [[ "${RUN:-}" == "1" ]]; then
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
