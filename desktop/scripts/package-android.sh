#!/usr/bin/env bash
# Builds the app for Android (Wails v3 mobile) as an installable APK, and
# with RUN=1 installs and launches it on the connected device or emulator:
#
#   client/out/renderer → desktop/frontend/dist
#     → go build -buildmode=c-shared (GOOS=android), per ABI
#       → build/android/app/src/main/jniLibs/<abi>/libwails.so
#     → gradle assembleRelease (version from client/package.json)
#     → bin/android/Boson-<version>-android.apk
#
# Signing: with ANDROID_KEYSTORE_FILE (+ ANDROID_KEYSTORE_PASSWORD,
# ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD) the release key; without it the
# debug key, which installs fine but can't update an APK signed with the
# release key (or the other way round).
#
# Environment:
#   DEV=1           a dev build: the renderer from client/.env, devBuild=true,
#                   API proxy allowed to reach http://10.0.2.2:3000 (the host
#                   Mac, as the emulator sees it)
#   ARCHS           Go architectures to include (default "arm64"; add amd64
#                   for x86_64 emulators and Chromebooks)
#   RUN=1           install + launch with adb
#   SKIP_RENDERER=1 reuse client/out/renderer as it is
#   ANDROID_HOME    the SDK (default ~/Library/Android/sdk, ~/Android/Sdk)
#   ANDROID_NDK_HOME the NDK (default the newest under $ANDROID_HOME/ndk)
#
# Needs a JDK 17+ (JAVA_HOME). Gradle comes from the wrapper.
#
# Usage: desktop/scripts/package-android.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
repo="$(dirname "$desktop")"
client="$repo/client"
project="$desktop/build/android"

APP_NAME=Boson
APP_ID=chat.boson.app
MIN_SDK=26
VERSION="$(cd "$client" && node -p "require('./package.json').version")"
# 1.2.3 → 10203: grows with every release, as Android requires of updates.
IFS=. read -r major minor patch <<<"${VERSION%%-*}"
VERSION_CODE=$((major * 10000 + minor * 100 + patch))
out="$desktop/bin/android"
mkdir -p "$out"

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk" ]]; then
  for d in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    [[ -d "$d" ]] && { sdk="$d"; break; }
  done
fi
[[ -d "$sdk" ]] || { echo "Android SDK not found (set ANDROID_HOME)" >&2; exit 1; }
export ANDROID_HOME="$sdk"
ndk="${ANDROID_NDK_HOME:-$(ls -d "$sdk"/ndk/* 2>/dev/null | sort -V | tail -1)}"
[[ -d "$ndk" ]] || { echo "Android NDK not found (set ANDROID_NDK_HOME)" >&2; exit 1; }
case "$(uname -s)" in
  Darwin) host_tag=darwin-x86_64 ;;
  Linux)  host_tag=linux-x86_64 ;;
  *)      echo "unsupported host $(uname -s)" >&2; exit 1 ;;
esac
toolchain="$ndk/toolchains/llvm/prebuilt/$host_tag/bin"

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

# 2. The Go app as a shared library per ABI.
tags=android
ldflags="-X main.appVersion=$VERSION"
if [[ "${DEV:-}" == "1" ]]; then
  ldflags="$ldflags -X main.devBuild=true -X main.apiBase=http://10.0.2.2:3000"
else
  tags="$tags,production"
  ldflags="$ldflags -s -w"
fi
jni="$project/app/src/main/jniLibs"
rm -rf "$jni"
for arch in ${ARCHS:-arm64}; do
  case "$arch" in
    arm64) abi=arm64-v8a; triple=aarch64-linux-android ;;
    amd64) abi=x86_64;    triple=x86_64-linux-android ;;
    *)     echo "unsupported arch $arch" >&2; exit 1 ;;
  esac
  echo "building the Go library ($tags, $abi)"
  mkdir -p "$jni/$abi"
  (cd "$desktop" && GOOS=android GOARCH="$arch" CGO_ENABLED=1 \
    CC="$toolchain/$triple$MIN_SDK-clang" CXX="$toolchain/$triple$MIN_SDK-clang++" \
    go build -buildmode=c-shared -tags "$tags" -trimpath -buildvcs=false -ldflags "$ldflags" \
      -o "$jni/$abi/libwails.so" .)
  rm -f "$jni/$abi/libwails.h"
done

# 3. The APK.
(cd "$project" && ./gradlew --no-daemon --quiet assembleRelease \
  -PbosonVersionName="$VERSION" -PbosonVersionCode="$VERSION_CODE")
apk="$out/$APP_NAME-$VERSION-android.apk"
cp "$project/app/build/outputs/apk/release/app-release.apk" "$apk"
echo "apk: $apk"

# 4. Run.
if [[ "${RUN:-}" == "1" ]]; then
  adb="$(command -v adb || echo "$sdk/platform-tools/adb")"
  "$adb" install -r "$apk"
  "$adb" shell am start -n "$APP_ID/com.wails.app.MainActivity"
fi
