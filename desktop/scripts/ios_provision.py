#!/usr/bin/env python3
"""Provision iOS development signing through the App Store Connect API.

For installing the app on your own iPhone (package-ios.sh, IOS_PLATFORM=
device): makes sure the bundle id exists for iOS, an Apple Development
certificate whose private key is on this Mac (created on first use, kept in
~/.config/boson-signing/ and imported into the login keychain), the device
is registered, and a development provisioning profile covers all three.
Writes the profile to --out and prints the signing identity's SHA-1.

Needs the App Store Connect API key (the one notarization uses):
  APPLE_API_KEY      path to the .p8
  APPLE_API_KEY_ID   its key id
  APPLE_API_ISSUER   the issuer id
Only the standard library and openssl. Never prints key material.

Usage: ios_provision.py --udid <device UDID> --out profile.mobileprovision
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API = "https://api.appstoreconnect.apple.com/v1"
BUNDLE_ID = "chat.boson.app"
SIGNING_DIR = os.path.expanduser("~/.config/boson-signing")
DEV_KEY = os.path.join(SIGNING_DIR, "ios-development.key")
PROFILE_NAME = "Boson iOS Development"


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def der_to_raw_ecdsa(der: bytes) -> bytes:
    # ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } → r||s, 32 bytes each.
    assert der[0] == 0x30
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b""
    for _ in range(2):
        assert der[i] == 0x02
        n = der[i + 1]
        v = der[i + 2 : i + 2 + n].lstrip(b"\x00")
        out += v.rjust(32, b"\x00")
        i += 2 + n
    return out


def token() -> str:
    key, kid, iss = os.environ["APPLE_API_KEY"], os.environ["APPLE_API_KEY_ID"], os.environ["APPLE_API_ISSUER"]
    now = int(time.time())
    head = b64url(json.dumps({"alg": "ES256", "kid": kid, "typ": "JWT"}).encode())
    body = b64url(json.dumps({"iss": iss, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}).encode())
    signing = f"{head}.{body}".encode()
    der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key], input=signing, capture_output=True, check=True).stdout
    return f"{head}.{body}.{b64url(der_to_raw_ecdsa(der))}"


def api(method: str, path: str, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None)
    req.add_header("Authorization", "Bearer " + token())
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r) if r.status != 204 else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:600]
        sys.exit(f"App Store Connect {method} {path}: HTTP {e.code}: {detail}")


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def bundle_id() -> str:
    r = api("GET", f"/bundleIds?filter[identifier]={BUNDLE_ID}&limit=20")
    for b in r["data"]:
        if b["attributes"]["identifier"] == BUNDLE_ID and b["attributes"]["platform"] in ("IOS", "UNIVERSAL"):
            log(f"bundle id {BUNDLE_ID}: exists ({b['attributes']['platform']})")
            return b["id"]
    r = api("POST", "/bundleIds", {"data": {"type": "bundleIds", "attributes": {
        "identifier": BUNDLE_ID, "name": "Boson", "platform": "IOS"}}})
    log(f"bundle id {BUNDLE_ID}: registered")
    return r["data"]["id"]


def public_key_der(path: str) -> bytes:
    return subprocess.run(["openssl", "pkey", "-in", path, "-pubout", "-outform", "DER"], capture_output=True, check=True).stdout


def certificate() -> tuple[str, str]:
    """(certificate id, SHA-1 of the signing identity) for a development cert whose key is DEV_KEY."""
    os.makedirs(SIGNING_DIR, mode=0o700, exist_ok=True)
    if os.path.exists(DEV_KEY):
        mine = public_key_der(DEV_KEY)
        r = api("GET", "/certificates?filter[certificateType]=DEVELOPMENT,IOS_DEVELOPMENT&limit=200")
        for c in r["data"]:
            der = base64.b64decode(c["attributes"]["certificateContent"])
            pub = subprocess.run(["openssl", "x509", "-inform", "DER", "-pubkey", "-noout"], input=der, capture_output=True, check=True).stdout
            pub_der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "DER"], input=pub, capture_output=True, check=True).stdout
            if pub_der == mine:
                log("development certificate: exists")
                return c["id"], install(der)
    else:
        subprocess.run(["openssl", "genrsa", "-out", DEV_KEY, "2048"], capture_output=True, check=True)
        os.chmod(DEV_KEY, 0o600)
    csr = subprocess.run(["openssl", "req", "-new", "-key", DEV_KEY, "-subj", "/CN=Boson iOS Development/O=Boson",
                          "-outform", "PEM"], capture_output=True, check=True).stdout.decode()
    r = api("POST", "/certificates", {"data": {"type": "certificates", "attributes": {
        "certificateType": "DEVELOPMENT", "csrContent": csr}}})
    log("development certificate: created")
    der = base64.b64decode(r["data"]["attributes"]["certificateContent"])
    return r["data"]["id"], install(der)


def install(cert_der: bytes) -> str:
    """Import the certificate + DEV_KEY into the login keychain (once); return its SHA-1."""
    import hashlib
    sha1 = hashlib.sha1(cert_der).hexdigest().upper()
    have = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"], capture_output=True, text=True).stdout
    if sha1 in have:
        return sha1
    with tempfile.TemporaryDirectory() as d:
        cer, p12 = os.path.join(d, "dev.cer"), os.path.join(d, "dev.p12")
        open(cer, "wb").write(cert_der)
        pw = base64.b64encode(os.urandom(18)).decode()
        subprocess.run(["openssl", "pkcs12", "-export", "-inkey", DEV_KEY, "-in", cer, "-inform", "DER",
                        "-out", p12, "-passout", "pass:" + pw, "-legacy"], capture_output=True, check=True)
        subprocess.run(["security", "import", p12, "-P", pw, "-T", "/usr/bin/codesign"], capture_output=True, check=True)
    log("development certificate: imported into the login keychain")
    return sha1


def device(udid: str, name: str) -> str:
    r = api("GET", f"/devices?filter[udid]={udid}&limit=5")
    if r["data"]:
        log("device: registered already")
        return r["data"][0]["id"]
    r = api("POST", "/devices", {"data": {"type": "devices", "attributes": {"name": name, "udid": udid, "platform": "IOS"}}})
    log("device: registered")
    return r["data"]["id"]


def profile(bid: str, cid: str, did: str) -> bytes:
    # A fresh profile each time (cheap, and always covers this cert + device).
    r = api("GET", f"/profiles?filter[name]={PROFILE_NAME.replace(' ', '%20')}&limit=20")
    for p in r["data"]:
        api("DELETE", f"/profiles/{p['id']}")
    r = api("POST", "/profiles", {"data": {"type": "profiles",
        "attributes": {"name": PROFILE_NAME, "profileType": "IOS_APP_DEVELOPMENT"},
        "relationships": {
            "bundleId": {"data": {"type": "bundleIds", "id": bid}},
            "certificates": {"data": [{"type": "certificates", "id": cid}]},
            "devices": {"data": [{"type": "devices", "id": did}]},
        }}})
    log("provisioning profile: created")
    return base64.b64decode(r["data"]["attributes"]["profileContent"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--udid", required=True)
    ap.add_argument("--name", default="Boson test iPhone")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    bid = bundle_id()
    cid, sha1 = certificate()
    did = device(a.udid, a.name)
    open(a.out, "wb").write(profile(bid, cid, did))
    print(sha1)


if __name__ == "__main__":
    main()
