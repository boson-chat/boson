#!/usr/bin/env bash
# Builds libopus as a static library, for voice (desktop/voice_audio.go via
# quicvoice's client/voice → gopkg.in/hraban/opus.v2, which finds it with
# pkg-config). Static, so users don't need libopus installed: the release
# binaries link it in.
#
#   desktop/scripts/build-opus.sh <prefix> [macOS arch: arm64 | x86_64]
#
# Then build with PKG_CONFIG_PATH=<prefix>/lib/pkgconfig and the
# nolibopusfile build tag (only libopus is used, not libopusfile).
#
# Needs cmake and a C compiler (Windows: MSYS2's MinGW-w64 gcc + cmake +
# ninja on PATH). A prefix that already has this version is left as it is.
set -euo pipefail

OPUS_VERSION=1.6.1
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1

prefix="${1:?usage: build-opus.sh <prefix> [arch]}"
arch="${2:-}"
mkdir -p "$prefix"
prefix="$(cd "$prefix" && pwd)"
marker="$prefix/.opus-$OPUS_VERSION${arch:+-$arch}"
if [[ -f "$marker" && -f "$prefix/lib/pkgconfig/opus.pc" ]]; then
  echo "libopus $OPUS_VERSION already in $prefix"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 -o "$work/opus.tar.gz" "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz"
if command -v sha256sum >/dev/null; then
  sum="$(sha256sum "$work/opus.tar.gz" | cut -d' ' -f1)"
else
  sum="$(shasum -a 256 "$work/opus.tar.gz" | cut -d' ' -f1)"
fi
[[ "$sum" == "$OPUS_SHA256" ]] || { echo "opus-$OPUS_VERSION.tar.gz: sha256 $sum, want $OPUS_SHA256" >&2; exit 1; }
tar -C "$work" -xzf "$work/opus.tar.gz"

install_prefix="$prefix"
args=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DOPUS_BUILD_SHARED_LIBRARY=OFF
  -DOPUS_BUILD_PROGRAMS=OFF
  -DOPUS_BUILD_TESTING=OFF
  -DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DCMAKE_INSTALL_LIBDIR=lib
)
case "$(uname -s)" in
  Darwin)
    args+=(-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0)
    [[ -n "$arch" ]] && args+=(-DCMAKE_OSX_ARCHITECTURES="$arch")
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # gcc and pkg-config are native Windows programs: give them C:/… paths.
    install_prefix="$(cygpath -m "$prefix")"
    args+=(-G Ninja)
    # _FORTIFY_SOURCE/stack protector would need libssp at link time.
    args+=(-DOPUS_HARDENING=OFF)
    ;;
esac
args+=(-DCMAKE_INSTALL_PREFIX="$install_prefix")

src="$work/opus-$OPUS_VERSION"
cmake -S "$src" -B "$work/build" "${args[@]}"
cmake --build "$work/build" --config Release --parallel
cmake --install "$work/build" --config Release
# Only the static library may be found.
rm -f "$prefix"/lib/libopus*.dylib "$prefix"/lib/libopus*.so* "$prefix"/lib/libopus.dll.a
# Link the archive by path: with -L… -lopus, a shared libopus in another
# directory on the link line (Homebrew's, a distro's) can win.
pc="$prefix/lib/pkgconfig/opus.pc"
sed -e 's|^Libs: .*|Libs: ${libdir}/libopus.a|' "$pc" > "$pc.tmp" && mv "$pc.tmp" "$pc"
touch "$marker"
echo "libopus $OPUS_VERSION → $prefix"
