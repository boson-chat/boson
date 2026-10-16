#!/usr/bin/env bash
# Builds the Wails desktop app as a signed (and optionally notarized)
# universal macOS bundle and DMG:
#
#   client/out/renderer (npm run build, production env)
#     → desktop/frontend/dist → arm64 + amd64 binaries → lipo
#     → bin/<APP_NAME>.app → codesign (hardened runtime) → DMG
#     → notarytool + stapler (when NOTARY_PROFILE is set)
#
# Environment:
#   APP_NAME        bundle name (default "Boson")
#   BUNDLE_ID       CFBundleIdentifier (default chat.boson.app)
#   SIGN_IDENTITY   codesign identity (default: the keychain's Developer ID
#                   Application identity; "-" signs ad hoc)
#   NOTARY_PROFILE  notarytool keychain profile (xcrun notarytool
#                   store-credentials); unset skips notarization
#   SKIP_RENDERER=1 reuse client/out/renderer as it is
#
# Usage: desktop/scripts/package-macos.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
repo="$(dirname "$desktop")"
client="$repo/client"

APP_NAME="${APP_NAME:-Boson}"
BUNDLE_ID="${BUNDLE_ID:-chat.boson.app}"
VERSION="$(node -p "require('$client/package.json').version")"
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
app="$out/$APP_NAME.app"
dmg="$out/$APP_NAME-$VERSION-mac-universal.dmg"
mkdir -p "$out"

# 1. Renderer: the production bundle (client/.env.production).
if [[ "${SKIP_RENDERER:-}" != "1" ]]; then
  (cd "$client" && npm run build)
fi
[[ -f "$client/out/renderer/index.html" ]] || { echo "client/out/renderer is missing" >&2; exit 1; }
rm -rf "$desktop/frontend/dist"
cp -R "$client/out/renderer" "$desktop/frontend/dist"
touch "$desktop/frontend/dist/.gitkeep"

# 2. Binaries: production build (no devtools), both architectures.
ldflags="-s -w -X main.appVersion=$VERSION"
for arch in arm64 amd64; do
  echo "building $arch"
  (cd "$desktop" && GOARCH="$arch" go build -tags production -trimpath -buildvcs=false \
    -ldflags "$ldflags" -o "$out/$APP_NAME-$arch" .)
done
lipo -create -output "$out/$APP_NAME-universal" "$out/$APP_NAME-arm64" "$out/$APP_NAME-amd64"

# 3. Bundle.
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
mv "$out/$APP_NAME-universal" "$app/Contents/MacOS/$APP_NAME"
rm -f "$out/$APP_NAME-arm64" "$out/$APP_NAME-amd64"
cp "$desktop/build/darwin/icons.icns" "$app/Contents/Resources/icons.icns"
cp "$desktop/build/darwin/Assets.car" "$app/Contents/Resources/Assets.car"
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
  <key>CFBundleIconName</key><string>appicon</string>
  <key>LSMinimumSystemVersion</key><string>12.0.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.social-networking</string>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Boson</string>
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

# 4. Sign: hardened runtime + secure timestamp (both required to notarize).
if [[ "$SIGN_IDENTITY" == "-" ]]; then
  codesign --force --sign - "$app"
else
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$app"
fi
codesign --verify --strict --verbose=2 "$app"

notarize() {
  xcrun notarytool submit "$1" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$2"
  xcrun stapler validate "$2"
}

# 5. Notarize the app itself, so a copy taken out of the DMG is stapled too.
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  zip="$out/$APP_NAME-notarize.zip"
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  notarize "$zip" "$app"
  rm -f "$zip"
  spctl --assess --type execute --verbose=4 "$app"
fi

# 6. DMG: the app plus an Applications link to drag it onto.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -quiet -volname "$APP_NAME $VERSION" -srcfolder "$stage" -fs APFS -format UDZO "$dmg"
if [[ "$SIGN_IDENTITY" != "-" ]]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$dmg"
fi
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  notarize "$dmg" "$dmg"
fi

echo "app: $app"
echo "dmg: $dmg"
