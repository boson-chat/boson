#!/usr/bin/env python3
"""Packages a signed device build of Boson.app for over-the-air install:

  <out>/Boson-ios.ipa    a zip of Payload/Boson.app
  <out>/Boson-ios.plist  the itms-services manifest pointing at
                         <base-url>/Boson-ios.ipa

The bundle id and version come from the app's Info.plist. A phone installs
it from itms-services://?action=download-manifest&url=<base-url>/Boson-ios.plist
when it's one of the devices the embedded development profile lists.
package-ios.sh runs this with IPA_OUT / IPA_BASE_URL; CI attaches both files
to each release (.github/workflows/desktop.yml, the ios job).

Usage: ios_ota.py --app <Boson.app> --out <dir> --base-url <https://…/download/vX.Y.Z>
       ios_ota.py --manifest-only --bundle-id <id> --version <v> --out <dir> --base-url <url>
"""
import argparse
import os
import plistlib
import stat
import sys
import time
import zipfile

IPA = "Boson-ios.ipa"
MANIFEST = "Boson-ios.plist"


def write_ipa(app: str, dest: str) -> None:
    """Zips app as Payload/<name>.app, keeping file modes (the executable
    bit) and symlinks, without macOS metadata (__MACOSX, .DS_Store)."""
    app = os.path.normpath(app)
    root = os.path.join("Payload", os.path.basename(app))
    tmp = dest + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for d in ("Payload/", root + "/"):
            info = zipfile.ZipInfo(d, time.localtime()[:6])
            info.external_attr = (stat.S_IFDIR | 0o755) << 16
            z.writestr(info, b"")
        for dirpath, dirnames, filenames in os.walk(app):
            dirnames.sort()
            rel = os.path.relpath(dirpath, app)
            arc_dir = root if rel == "." else os.path.join(root, rel)
            for name in sorted(dirnames):
                path = os.path.join(dirpath, name)
                if os.path.islink(path):
                    filenames.append(name)
                    continue
                info = zipfile.ZipInfo(os.path.join(arc_dir, name) + "/", time.localtime()[:6])
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
                z.writestr(info, b"")
            for name in sorted(filenames):
                if name == ".DS_Store":
                    continue
                path = os.path.join(dirpath, name)
                arc = os.path.join(arc_dir, name)
                st = os.lstat(path)
                if stat.S_ISLNK(st.st_mode):
                    info = zipfile.ZipInfo(arc)
                    info.external_attr = (stat.S_IFLNK | 0o755) << 16
                    z.writestr(info, os.readlink(path))
                else:
                    z.write(path, arc)
    os.replace(tmp, dest)


def manifest(ipa_url: str, bundle_id: str, version: str, title: str) -> bytes:
    return plistlib.dumps({
        "items": [{
            "assets": [{"kind": "software-package", "url": ipa_url}],
            "metadata": {
                "bundle-identifier": bundle_id,
                "bundle-version": version,
                "kind": "software",
                "title": title,
            },
        }],
    })


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--app", help="the signed Boson.app (device build)")
    p.add_argument("--out", required=True, help="directory for Boson-ios.ipa and Boson-ios.plist")
    p.add_argument("--base-url", required=True, help="where both files are served, e.g. https://github.com/<owner>/<repo>/releases/download/vX.Y.Z")
    p.add_argument("--manifest-only", action="store_true", help="write only the manifest (with --bundle-id and --version)")
    p.add_argument("--bundle-id", help="override the app's CFBundleIdentifier")
    p.add_argument("--version", help="override the app's CFBundleShortVersionString")
    p.add_argument("--title", default="Boson")
    a = p.parse_args()

    base = a.base_url.rstrip("/")
    if not base.startswith("https://"):
        print(f"--base-url must be https (iOS refuses anything else): {base}", file=sys.stderr)
        return 2
    bundle_id, version = a.bundle_id, a.version
    if not a.manifest_only:
        if not a.app or not os.path.isfile(os.path.join(a.app, "Info.plist")):
            print("--app must be a built .app", file=sys.stderr)
            return 2
        if not os.path.isfile(os.path.join(a.app, "embedded.mobileprovision")):
            print(f"{a.app} has no embedded.mobileprovision: not a device build", file=sys.stderr)
            return 2
        with open(os.path.join(a.app, "Info.plist"), "rb") as f:
            info = plistlib.load(f)
        bundle_id = bundle_id or info["CFBundleIdentifier"]
        version = version or info["CFBundleShortVersionString"]
    if not bundle_id or not version:
        print("need a bundle id and version (--app, or --bundle-id and --version)", file=sys.stderr)
        return 2

    os.makedirs(a.out, exist_ok=True)
    if not a.manifest_only:
        write_ipa(a.app, os.path.join(a.out, IPA))
    with open(os.path.join(a.out, MANIFEST), "wb") as f:
        f.write(manifest(f"{base}/{IPA}", bundle_id, version, a.title))
    for name in ((MANIFEST,) if a.manifest_only else (IPA, MANIFEST)):
        print(os.path.join(a.out, name))
    print(f"install: itms-services://?action=download-manifest&url={base}/{MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
