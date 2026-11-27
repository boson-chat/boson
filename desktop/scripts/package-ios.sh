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
#                   backend + auth service), devBuild=true, API proxy allowed to
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
#   PROVISIONING_PROFILE / CODESIGN_IDENTITY  use these instead (with a
#                   profile no iPhone needs to be connected unless RUN=1:
#                   how CI builds the release IPA; never replaced by one
#                   ios_provision.py makes)
#   CODESIGN_KEYCHAIN  sign from this keychain instead of the search list
#   DEVICE_ID       the iPhone's UDID (default: the first connected one)
#   IPA_OUT / IPA_BASE_URL  also write the OTA-installable Boson-ios.ipa and
#                   its itms-services manifest Boson-ios.plist into IPA_OUT,
#                   the manifest pointing at IPA_BASE_URL/Boson-ios.ipa
#                   (scripts/ios_ota.py; device builds only)
#   OPUS_PREFIX     where the static libopus for voice is built and cached
#                   (default desktop/build/.opus; scripts/build-opus.sh)
#   PUSH_EXT_PROFILE  device builds: the provisioning profile for the push
#                   extension (chat.boson.app.push); default: an Xcode-managed
#                   one for it (or the team's wildcard). Without one the
#                   extension is left out and pushes show as "New message".
#
# Push notifications (docs/push-ios.md): the app gets aps-environment, the
# App Group and the App Attest environment only when its provisioning
# profile grants them (simulator builds always), so a profile made before
# push was set up still signs and installs; the APNs environment the Go side
# reports to the relay (main.apnsEnvironment) is the profile's.
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

# Device builds: the signing identity and the app's provisioning profile,
# found before the build (the APNs environment and the entitlements come
# from the profile).
team="$(/usr/libexec/PlistBuddy -c 'Print :application-identifier' "$desktop/build/ios/Device.entitlements" | cut -d. -f1)"
profile_plist() { security cms -D -i "$1" 2>/dev/null; }
# An Xcode-managed profile for $1 (a bundle id) that includes the device;
# wildcard ones only with $2 = wildcard.
find_profile() {
  local want="$1" wild="${2:-}" f plist appid
  for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision; do
    [[ -f "$f" ]] || continue
    plist="$(profile_plist "$f")" || continue
    appid="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' /dev/stdin <<<"$plist" 2>/dev/null || true)"
    if [[ ( "$appid" == "$team.$want" || ( -n "$wild" && "$appid" == "$team.*" ) ) && "$plist" == *"${DEVICE_ID:-}"* ]]; then
      echo "$f"
      return 0
    fi
  done
  return 1
}
if [[ "$PLATFORM" == "device" ]]; then
  profile="${PROVISIONING_PROFILE:-}"
  identity="${CODESIGN_IDENTITY:-}"
  keychain=()
  [[ -n "${CODESIGN_KEYCHAIN:-}" ]] && keychain=(--keychain "$CODESIGN_KEYCHAIN")
  # The device picks the profile and is where RUN=1 installs; a given
  # profile needs none.
  if [[ -z "$profile" || "${RUN:-}" == "1" ]]; then
    if [[ -z "${DEVICE_ID:-}" ]]; then
      DEVICE_ID="$(xcrun devicectl list devices --hide-headers 2>/dev/null | awk '/physical|paired/ && !/simulated/ { for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) { print $i; exit } }')"
    fi
    [[ -n "${DEVICE_ID:-}" ]] || { echo "no iPhone connected (or pass DEVICE_ID=<UDID>)" >&2; exit 1; }
  fi
  if [[ -z "$profile" ]]; then
    # An Xcode-managed profile for our team that includes this device.
    profile="$(find_profile chat.boson.app || find_profile chat.boson.app wildcard || true)"
  fi
  if [[ -n "$profile" && -z "$identity" ]]; then
    identity="$(security find-identity -v -p codesigning ${CODESIGN_KEYCHAIN:+"$CODESIGN_KEYCHAIN"} | awk '/Apple Development/ { print $2; exit }')"
  fi
  # A given profile is never replaced by one ios_provision.py makes (CI must
  # not create anything): no identity for it is an error.
  if [[ -n "${PROVISIONING_PROFILE:-}" && -z "$identity" ]]; then
    echo "no Apple Development identity${CODESIGN_KEYCHAIN:+ in $CODESIGN_KEYCHAIN} for PROVISIONING_PROFILE" >&2
    exit 1
  fi
  if [[ -z "$profile" || -z "$identity" ]]; then
    identity="$(python3 "$here/ios_provision.py" --udid "$DEVICE_ID" --out "$out/development.mobileprovision")"
    profile="$out/development.mobileprovision"
  fi
fi

# What the app's profile grants for push (simulator: everything, from
# build/ios/Simulator.entitlements).
APNS_ENV=development
push_ents=()
if [[ "$PLATFORM" == "device" ]]; then
  prof="$(profile_plist "$profile")"
  pe() { /usr/libexec/PlistBuddy -c "Print :Entitlements:$1" /dev/stdin <<<"$prof" 2>/dev/null || true; }
  aps="$(pe aps-environment)"
  if [[ -n "$aps" ]]; then
    APNS_ENV="$aps"
    push_ents+=(-c "Add :aps-environment string $aps")
  else
    echo "note: the provisioning profile has no Push Notifications capability: no push in this build (docs/push-ios.md)" >&2
  fi
  if [[ "$(pe com.apple.security.application-groups)" == *group.chat.boson.app* ]]; then
    push_ents+=(-c "Add :com.apple.security.application-groups array" -c "Add :com.apple.security.application-groups:0 string group.chat.boson.app")
  else
    echo "note: the provisioning profile lacks the App Group group.chat.boson.app: the push extension can't read keys" >&2
  fi
  # The profile lists the App Attest environments it allows (newer profiles
  # give an array, e.g. development and production); the app claims one,
  # as a string: the one matching the APNs environment when allowed.
  attest="$(pe com.apple.developer.devicecheck.appattest-environment)"
  if [[ "$attest" == Array* ]]; then
    if [[ "$attest" == *"$APNS_ENV"* ]]; then
      attest="$APNS_ENV"
    else
      attest="$(pe com.apple.developer.devicecheck.appattest-environment:0)"
    fi
  fi
  [[ -n "$attest" ]] && push_ents+=(-c "Add :com.apple.developer.devicecheck.appattest-environment string $attest")
fi

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

# 2. The Go app as a C archive, with voice: a static libopus for this SDK
#    (nolibopusfile: only libopus is used), linked into the app in step 3.
opus="${OPUS_PREFIX:-$desktop/build/.opus}/ios-$PLATFORM"
"$here/build-opus.sh" "$opus" "ios-$PLATFORM"
tags=ios,nolibopusfile
ldflags="-X main.appVersion=$VERSION -X main.apnsEnvironment=$APNS_ENV"
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
# The prefix in CGO_CFLAGS too: Go's build cache doesn't key on
# PKG_CONFIG_PATH, and would reuse a build against another libopus.
(cd "$desktop" && GOOS=ios GOARCH=arm64 CGO_ENABLED=1 \
  CC="$(xcrun --sdk "$SDK" --find clang)" \
  PKG_CONFIG_PATH="$opus/lib/pkgconfig" \
  CGO_CFLAGS="-isysroot $SDK_PATH -target $TARGET $VERSION_MIN -I$opus/include" \
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
  -framework LocalAuthentication -framework UserNotifications -framework DeviceCheck \
  -framework AVFoundation -framework SafariServices \
  -framework CoreLocation -framework CoreMotion -framework SystemConfiguration -framework Network \
  -framework AVFAudio -framework AudioToolbox -framework CoreAudio \
  -framework CoreMedia -framework CoreVideo -framework VideoToolbox -framework IOSurface -framework CoreGraphics \
  -lresolv "$opus/lib/libopus.a" \
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

# 4b. The push Notification Service Extension (build/ios/push/): decrypts
#     pushes with the keys the app shares through the App Group.
ext="$app/PlugIns/BosonPush.appex"
mkdir -p "$ext"
ext_ents=()
if [[ "$PLATFORM" != "device" ]]; then
  ext_ents=(-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements
    -Xlinker "$desktop/build/ios/push/Simulator.entitlements")
fi
xcrun -sdk "$SDK" swiftc -target "$TARGET" -sdk "$SDK_PATH" -O \
  -application-extension -parse-as-library -module-name BosonPush \
  -Xlinker -e -Xlinker _NSExtensionMain \
  -framework Foundation -framework UserNotifications -framework Security \
  ${ext_ents[@]+"${ext_ents[@]}"} \
  -o "$ext/BosonPush" \
  "$desktop/build/ios/push/PushCrypto.swift" "$desktop/build/ios/push/PushLine.swift" \
  "$desktop/build/ios/push/NotificationService.swift"
cp "$desktop/build/ios/push/Info.plist" "$ext/Info.plist"
sdk_platform=iPhoneOS
[[ "$PLATFORM" != "device" ]] && sdk_platform=iPhoneSimulator
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" -c "Set :CFBundleVersion $VERSION" \
  -c "Add :CFBundleSupportedPlatforms array" -c "Add :CFBundleSupportedPlatforms:0 string $sdk_platform" "$ext/Info.plist"
plutil -lint "$ext/Info.plist" >/dev/null

# 5. Sign. Simulator: ad hoc. Device: the development identity, with the
#    profile embedded and the matching entitlements.
if [[ "$PLATFORM" == "device" ]]; then
  cp "$profile" "$app/embedded.mobileprovision"
  # The extension: its own profile (or the team's wildcard), and the App
  # Group if that profile has it. Without one it's left out.
  ext_profile="${PUSH_EXT_PROFILE:-$(find_profile chat.boson.app.push || find_profile chat.boson.app.push wildcard || true)}"
  if [[ -n "$ext_profile" ]]; then
    cp "$ext_profile" "$ext/embedded.mobileprovision"
    ext_prof="$(profile_plist "$ext_profile")"
    ext_ent="$out/BosonPush.entitlements"
    cat >"$ext_ent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>application-identifier</key><string>$team.chat.boson.app.push</string>
  <key>com.apple.developer.team-identifier</key><string>$team</string>
  <key>get-task-allow</key><true/>
</dict></plist>
PLIST
    if [[ "$ext_prof" == *group.chat.boson.app* ]]; then
      /usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups array" \
        -c "Add :com.apple.security.application-groups:0 string group.chat.boson.app" "$ext_ent"
    fi
    codesign --force --sign "$identity" ${keychain[@]+"${keychain[@]}"} --entitlements "$ext_ent" --timestamp=none "$ext"
  else
    echo "note: no provisioning profile for chat.boson.app.push: the push extension is left out (pushes show as \"New message\")" >&2
    rm -rf "$app/PlugIns"
  fi
  # The app: Device.entitlements plus what the profile grants for push.
  app_ent="$out/Boson.entitlements"
  cp "$desktop/build/ios/Device.entitlements" "$app_ent"
  if [[ ${#push_ents[@]} -gt 0 ]]; then
    /usr/libexec/PlistBuddy "${push_ents[@]}" "$app_ent"
  fi
  codesign --force --sign "$identity" ${keychain[@]+"${keychain[@]}"} --entitlements "$app_ent" --timestamp=none "$app"
else
  codesign --force --sign - "$ext"
  codesign --force --sign - "$app"
fi
codesign --verify --verbose=1 "$app"
echo "app: $app"

# 5b. The OTA package: the IPA and its itms-services manifest.
if [[ -n "${IPA_OUT:-}" ]]; then
  [[ "$PLATFORM" == "device" ]] || { echo "IPA_OUT needs IOS_PLATFORM=device" >&2; exit 1; }
  [[ -n "${IPA_BASE_URL:-}" ]] || { echo "IPA_OUT needs IPA_BASE_URL" >&2; exit 1; }
  python3 "$here/ios_ota.py" --app "$app" --out "$IPA_OUT" --base-url "$IPA_BASE_URL"
fi

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
