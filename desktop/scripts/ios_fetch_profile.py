#!/usr/bin/env python3
"""Downloads an EXISTING iOS development provisioning profile for
chat.boson.app through the App Store Connect API, read-only: one GET of
/v1/profiles. Never creates, changes or deletes certificates, profiles,
devices or bundle ids (unlike ios_provision.py, which is for a local Mac).

CI uses it when the IOS_PROVISIONING_PROFILE_BASE64 secret isn't set
(.github/workflows/desktop.yml, the ios job). It picks an ACTIVE
IOS_APP_DEVELOPMENT profile whose app id is chat.boson.app, else the team
wildcard (*, e.g. Xcode's "iOS Team Provisioning Profile: *"), that lists
the signing certificate (--cert-sha1) and has the latest expiry.

Needs the App Store Connect API key (the one notarization uses):
  APPLE_API_KEY      path to the .p8
  APPLE_API_KEY_ID   its key id
  APPLE_API_ISSUER   the issuer id

Exit status: 0 with the profile written to --out; 3 when no matching active
profile exists (or the API refused: the caller skips the iOS build); 2 on
bad usage.

Usage: ios_fetch_profile.py --out profile.mobileprovision [--cert-sha1 <SHA-1>]
"""
import argparse
import base64
import hashlib
import json
import os
import plistlib
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ios_provision import API, BUNDLE_ID, token  # noqa: E402  (JWT signing only)

NO_PROFILE = 3


def get(path: str):
    """The only request this script makes: a GET."""
    req = urllib.request.Request(API + path, method="GET")
    req.add_header("Authorization", "Bearer " + token())
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def decode(content: bytes) -> dict:
    """The profile's plist, from its CMS envelope."""
    return plistlib.loads(subprocess.run(["openssl", "smime", "-inform", "der", "-verify", "-noverify"],
                                         input=content, capture_output=True, check=True).stdout)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--cert-sha1", default="", help="only profiles that list this certificate")
    a = ap.parse_args()
    want_cert = a.cert_sha1.replace(" ", "").upper()

    try:
        r = get("/profiles?filter[profileType]=IOS_APP_DEVELOPMENT&filter[profileState]=ACTIVE"
                "&include=bundleId&fields[bundleIds]=identifier&limit=200")
    except urllib.error.HTTPError as e:
        print(f"App Store Connect GET /profiles: HTTP {e.code}: {e.read().decode(errors='replace')[:400]}", file=sys.stderr)
        return NO_PROFILE
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"App Store Connect unreachable: {e}", file=sys.stderr)
        return NO_PROFILE

    ids = {b["id"]: b["attributes"]["identifier"] for b in r.get("included", []) if b["type"] == "bundleIds"}
    candidates = []
    for p in r.get("data", []):
        rel = ((p.get("relationships") or {}).get("bundleId") or {}).get("data") or {}
        ident = ids.get(rel.get("id"), "")
        if ident not in (BUNDLE_ID, "*"):
            continue
        content = base64.b64decode(p["attributes"]["profileContent"])
        plist = decode(content)
        certs = {hashlib.sha1(c).hexdigest().upper() for c in plist.get("DeveloperCertificates", [])}
        name = p["attributes"].get("name", "?")
        if want_cert and want_cert not in certs:
            print(f"skip {name!r}: doesn't list the signing certificate", file=sys.stderr)
            continue
        exact = ident == BUNDLE_ID
        candidates.append((exact, plist["ExpirationDate"], name, plist, content))
    if not candidates:
        print(f"no active development profile for {BUNDLE_ID} (or *) with that certificate", file=sys.stderr)
        return NO_PROFILE

    candidates.sort(key=lambda c: (c[0], c[1]), reverse=True)
    _, expires, name, plist, content = candidates[0]
    with open(a.out, "wb") as f:
        f.write(content)
    print(f"profile {name!r}: app id {plist['Entitlements']['application-identifier']}, "
          f"{len(plist.get('ProvisionedDevices', []))} devices, expires {expires:%Y-%m-%d}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
