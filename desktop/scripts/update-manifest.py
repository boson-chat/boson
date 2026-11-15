#!/usr/bin/env python3
"""Writes update-manifest.json for a release: per platform, the in-app
updater's payload (name, size, sha256), the version, and the oldest version
that may update to it in place. CI signs the exact bytes this prints
(.github/workflows/desktop.yml); the app reads it in
desktop/internal/selfupdate/manifest.go.

Usage: update-manifest.py <release dir> <version> <min version> > update-manifest.json
"""
import hashlib
import json
import os
import re
import sys

# Release asset → platform key (GOOS-GOARCH, selfupdate.PlatformKey).
PAYLOADS = {
    "Boson-mac-arm64.app.zip": "darwin-arm64",
    "Boson-mac-x64.app.zip": "darwin-amd64",
    "Boson-windows-x64.zip": "windows-amd64",
    "Boson-linux-x86_64.tar.gz": "linux-amd64",
    "Boson-android.apk": "android-arm64",
}
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    release, version, min_version = sys.argv[1], sys.argv[2].lstrip("v"), sys.argv[3].lstrip("v")
    for v in (version, min_version):
        if not SEMVER.match(v):
            print(f"not a version: {v!r}", file=sys.stderr)
            return 2
    assets = {}
    for name, platform in PAYLOADS.items():
        path = os.path.join(release, name)
        if not os.path.isfile(path):
            print(f"note: no {name}; {platform} updates from the release page", file=sys.stderr)
            continue
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        assets[platform] = {"name": name, "size": os.path.getsize(path), "sha256": h.hexdigest()}
    if not assets:
        print("no update payloads found", file=sys.stderr)
        return 1
    manifest = {"schema": 1, "version": version, "minVersion": min_version, "assets": assets}
    sys.stdout.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
