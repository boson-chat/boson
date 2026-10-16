#!/usr/bin/env bash
# Builds the Wails desktop app as signed (and optionally notarized) macOS
# bundles and DMGs, one per architecture (Apple Silicon, Intel):
#
#   client/out/renderer (npm run build, production env)
#     → desktop/frontend/dist → per arch: binary
#     → bin/mac-<arch>/<APP_NAME>.app → codesign (hardened runtime)
#     → notarytool + stapler (with notary credentials, below)
#     → bin/<APP_NAME>-<version>-mac-<arch>.dmg (signed, notarized)
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
mkdir -p "$out"

# 1. Renderer: the production bundle (client/.env.production).
if [[ "${SKIP_RENDERER:-}" != "1" ]]; then
  (cd "$client" && npm run build)
fi
[[ -f "$client/out/renderer/index.html" ]] || { echo "client/out/renderer is missing" >&2; exit 1; }
rm -rf "$desktop/frontend/dist"
cp -R "$client/out/renderer" "$desktop/frontend/dist"
touch "$desktop/frontend/dist/.gitkeep"

ldflags="-s -w -X main.appVersion=$VERSION"
# Another YouTube wrapper origin (default https://boson.chat; a PR's website
# preview to try changes to it). Unset: the build's default.
[[ -n "${YOUTUBE_WRAPPER:-}" ]] && ldflags="$ldflags -X main.youtubeWrapperOrigin=$YOUTUBE_WRAPPER"

notary=()
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  notary=(--keychain-profile "$NOTARY_PROFILE")
elif [[ -n "${APPLE_API_KEY:-}" ]]; then
  notary=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
fi

notarize() {
  xcrun notarytool submit "$1" "${notary[@]}" --wait
  xcrun stapler staple "$2"
  xcrun stapler validate "$2"
}

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

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

  # 2. Binary: production build (no devtools).
  echo "building $arch"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  (cd "$desktop" && GOARCH="$goarch" go build -tags production -trimpath -buildvcs=false \
    -ldflags "$ldflags" -o "$app/Contents/MacOS/$APP_NAME" .)
  lipo -archs "$app/Contents/MacOS/$APP_NAME"

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

  # 5. Notarize the app itself, so a copy taken out of the DMG is stapled too.
  if [[ ${#notary[@]} -gt 0 ]]; then
    zip="$out/$APP_NAME-notarize.zip"
    rm -f "$zip"
    ditto -c -k --keepParent "$app" "$zip"
    notarize "$zip" "$app"
    rm -f "$zip"
    spctl --assess --type execute --verbose=4 "$app"
  fi

  # 6. DMG: the app plus an Applications link to drag it onto.
  rm -rf "${stage:?}"/*
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
}

for arch in ${ARCHS:-arm64 x64}; do
  package "$arch"
done
