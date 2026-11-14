#!/usr/bin/env bash
# Builds the Wails desktop app for Windows or Linux (macOS has its own
# script, package-macos.sh, for the bundle, signing and notarization):
#
#   windows  bin/Boson-<version>-windows-<arch>.zip: Boson.exe with the icon,
#            version info and manifest embedded (a .syso). Unsigned until an
#            Authenticode certificate is in place. Needs the WebView2
#            runtime, which Windows 10/11 ship.
#   linux    bin/Boson-<version>-linux-<arch>.tar.gz: the binary, a .desktop
#            entry (boson:// handler) and the icon. Needs GTK 4 and
#            WebKitGTK 6.0 (libgtk-4-1, libwebkitgtk-6.0-4) at runtime; the
#            -dev packages to build.
#
# Both link libopus statically for voice (scripts/build-opus.sh, cached in
# OPUS_PREFIX, default desktop/build/.opus) and need cgo: Windows builds
# with MSYS2's MinGW-w64 gcc (plus cmake, ninja and pkgconf) on PATH.
#
# Environment: SKIP_RENDERER=1 reuses client/out/renderer as it is.
# Needs the wails3 CLI on PATH (Windows: for the .syso).
#
# Usage: desktop/scripts/package.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
repo="$(dirname "$desktop")"
client="$repo/client"

case "$(uname -s)" in
  Linux) os=linux ;;
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  *) echo "package.sh builds Windows and Linux; on macOS use package-macos.sh" >&2; exit 1 ;;
esac
arch="$(go env GOARCH)"
# Read from inside client/: under Git Bash, a /d/... path means nothing to Node.
VERSION="$(cd "$client" && node -p "require('./package.json').version")"
out="$desktop/bin"
mkdir -p "$out"

# 1. Renderer: the production bundle (client/.env.production, or the
#    VITE_* variables CI sets).
if [[ "${SKIP_RENDERER:-}" != "1" ]]; then
  (cd "$client" && npm run build)
fi
[[ -f "$client/out/renderer/index.html" ]] || { echo "client/out/renderer is missing" >&2; exit 1; }
rm -rf "$desktop/frontend/dist"
cp -R "$client/out/renderer" "$desktop/frontend/dist"
touch "$desktop/frontend/dist/.gitkeep"

ldflags="-s -w -X main.appVersion=$VERSION"
# Voice: libopus, built static (nolibopusfile: only libopus is used).
OPUS_PREFIX="${OPUS_PREFIX:-$desktop/build/.opus}/$os-$arch"
"$here/build-opus.sh" "$OPUS_PREFIX"
export PKG_CONFIG_PATH="$OPUS_PREFIX/lib/pkgconfig"
[[ "$os" == windows ]] && PKG_CONFIG_PATH="$(cygpath -m "$PKG_CONFIG_PATH")"
# Go's build cache doesn't key on PKG_CONFIG_PATH; CGO_CFLAGS it does.
opus_inc="$OPUS_PREFIX/include"
[[ "$os" == windows ]] && opus_inc="$(cygpath -m "$opus_inc")"
export CGO_CFLAGS="${CGO_CFLAGS:-} -I$opus_inc"
tags=production,nolibopusfile
# Another YouTube wrapper origin (default https://boson.chat; a PR's website
# preview to try changes to it). Unset: the build's default.
[[ -n "${YOUTUBE_WRAPPER:-}" ]] && ldflags="$ldflags -X main.youtubeWrapperOrigin=$YOUTUBE_WRAPPER"
stage="$(mktemp -d)"
trap 'rm -rf "$stage" "$desktop/wails_windows_$arch.syso"' EXIT

if [[ "$os" == windows ]]; then
  # Icon, version info and manifest, with this release's version.
  sed -E "s/\"(file_version|ProductVersion)\": \"[^\"]*\"/\"\1\": \"$VERSION\"/" \
    "$desktop/build/windows/info.json" > "$stage/info.json"
  sed -E "s/(name=\"chat\.boson\.app\" version=\")[^\"]*/\1$VERSION.0/" \
    "$desktop/build/windows/wails.exe.manifest" > "$stage/wails.exe.manifest"
  wails3 generate syso -arch "$arch" -icon "$desktop/build/windows/icon.ico" \
    -manifest "$stage/wails.exe.manifest" -info "$stage/info.json" \
    -out "$desktop/wails_windows_$arch.syso"
  # cgo for voice (miniaudio, libopus); -static so Boson.exe needs no
  # MinGW runtime DLLs next to it.
  (cd "$desktop" && CGO_ENABLED=1 go build -tags "$tags" -trimpath -buildvcs=false \
    -ldflags "$ldflags -H windowsgui -extldflags=-static" -o "$stage/Boson/Boson.exe" .)
  if objdump -p "$stage/Boson/Boson.exe" | grep -iE 'DLL Name: (libopus|libgcc|libwinpthread|libstdc)'; then
    echo "Boson.exe needs MinGW DLLs" >&2
    exit 1
  fi
  artifact="$out/Boson-$VERSION-windows-$arch.zip"
  rm -f "$artifact"
  (cd "$stage" && powershell -NoProfile -Command "Compress-Archive -Path Boson -DestinationPath '$(cygpath -w "$artifact")'")
else
  (cd "$desktop" && CGO_ENABLED=1 go build -tags "$tags" -trimpath -buildvcs=false \
    -ldflags "$ldflags" -o "$stage/Boson/boson" .)
  if ldd "$stage/Boson/boson" | grep -q libopus; then
    echo "the binary links a shared libopus" >&2
    exit 1
  fi
  cp "$desktop/build/appicon.png" "$stage/Boson/boson.png"
  cat > "$stage/Boson/boson.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Boson
Comment=Boson chat
Exec=boson %u
Icon=boson
Terminal=false
Categories=Network;Chat;InstantMessaging;
MimeType=x-scheme-handler/boson;
StartupWMClass=chat.boson.app
DESKTOP
  artifact="$out/Boson-$VERSION-linux-$arch.tar.gz"
  tar -C "$stage" -czf "$artifact" Boson
fi

echo "artifact: $artifact"
