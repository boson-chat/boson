# iOS builds on GitHub Releases

Each release can carry a development-signed iPhone build that installs over
the air on the team's registered test devices:

- `Boson-ios.ipa`: a zip of `Payload/Boson.app`, signed with an
  "Apple Development" certificate, with the development provisioning
  profile embedded.
- `Boson-ios.plist`: the `itms-services` install manifest. It names
  `https://github.com/boson-chat/boson/releases/download/vX.Y.Z/Boson-ios.ipa`,
  bundle id `chat.boson.app`, the version, and the title Boson.

The `ios` job in `.github/workflows/desktop.yml` builds them. It runs
`desktop/scripts/package-ios.sh` with `IOS_PLATFORM=device`, and
`desktop/scripts/ios_ota.py` writes the IPA and the manifest. The
`release-assets` job then attaches both to the release. They are listed in
`SHA256SUMS.txt`, but they are not in the signed `update-manifest.json`:
iOS has no in-app update, and the desktop updater only reads the assets
that manifest names.

## Install

On a registered iPhone, open this link in Safari, replacing `vX.Y.Z` with
the release tag:

```
itms-services://?action=download-manifest&url=https://github.com/boson-chat/boson/releases/download/vX.Y.Z/Boson-ios.plist
```

Then confirm the install. The first time, trust the developer under
Settings → General → VPN & Device Management. iOS 16 and later also need
Settings → Privacy & Security → Developer Mode switched on.

## What it exposes, and who can install it

> **The IPA is public, and so is the provisioning profile inside it.**
> Anyone can download it from the release and read
> `Payload/Boson.app/embedded.mobileprovision`. That file contains the
> **UDID of every registered device** in the profile, the **developer's
> name** and team from the signing certificate, and the team ID.
> Only publish a profile whose device list and certificate name you're
> willing to make public.

The app installs **only on the devices the profile lists**. Any other
iPhone refuses it ("Unable to install"). To add a phone, register its UDID
in the Apple Developer account (or let Xcode do it by running a build on
that phone), then refresh the profile. With the API path below, the next
release picks up the new profile on its own. With the secret path, update
`IOS_PROVISIONING_PROFILE_BASE64`. A development profile expires after
about a year, and builds signed with it stop launching after that.

## Secrets

Two secrets are always needed: the signing identity.

| Secret | What |
| --- | --- |
| `IOS_SIGNING_CERT_P12_BASE64` | base64 of an **Apple Development** certificate and its private key, exported as `.p12` |
| `IOS_SIGNING_CERT_PASSWORD` | the `.p12`'s export password |

`CSC_LINK` won't do: its Developer ID Application certificate can't sign
iOS apps.

The provisioning profile comes from one of two places, tried in this order:

1. **`IOS_PROVISIONING_PROFILE_BASE64`** (optional): base64 of the
   `.mobileprovision` file.
2. **Without that secret, the App Store Connect API**, using the
   `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` key that
   notarization already uses. `desktop/scripts/ios_fetch_profile.py` makes
   one read-only `GET /v1/profiles` request. It looks for active
   `IOS_APP_DEVELOPMENT` profiles and picks one for `chat.boson.app`, or
   failing that the team wildcard `*` (Xcode's
   "iOS Team Provisioning Profile: *"). The profile must list the signing
   certificate; if several match, the one with the latest expiry wins.
   The script **never** creates, changes or deletes certificates,
   profiles, devices or bundle IDs.

In both cases the job then checks that the profile covers
`FJY7UPX884.chat.boson.app` (or `FJY7UPX884.*`), lists the certificate,
lists at least one device, and hasn't expired.

### Export the certificate as .p12

1. Open Keychain Access and select the login keychain, under My Certificates.
2. Find **Apple Development: <name> (<id>)** and expand it to check that
   the private key is underneath.
3. Right-click the certificate, choose Export, and save it as Personal
   Information Exchange (.p12) with a strong password.
4. Then:

```sh
base64 -i ~/Desktop/ios-development.p12 | gh secret set IOS_SIGNING_CERT_P12_BASE64 --repo boson-chat/boson
gh secret set IOS_SIGNING_CERT_PASSWORD --repo boson-chat/boson   # paste the .p12 password at the prompt
rm ~/Desktop/ios-development.p12
```

The certificate must be one the profile lists. With Xcode-managed signing,
that's the Apple Development certificate Xcode uses on this Mac.

### Pick the profile (only for the IOS_PROVISIONING_PROFILE_BASE64 path)

Xcode keeps its managed profiles in
`~/Library/Developer/Xcode/UserData/Provisioning Profiles/`. Older Xcodes
used `~/Library/MobileDevice/Provisioning Profiles/`. The files are named
by UUID, so decode each one to find the right profile:

```sh
cd ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles
for f in *.mobileprovision; do
  p="$(openssl smime -inform der -verify -noverify -in "$f" 2>/dev/null)"
  echo "== $f"
  /usr/libexec/PlistBuddy -c 'Print :Name' -c 'Print :TeamIdentifier:0' \
    -c 'Print :Entitlements:application-identifier' -c 'Print :ExpirationDate' /dev/stdin <<<"$p"
  /usr/libexec/PlistBuddy -c 'Print :ProvisionedDevices' /dev/stdin <<<"$p"
done
```

Choose the profile that matches all of these:

- **team** `FJY7UPX884`;
- **app id** `FJY7UPX884.chat.boson.app`, or the wildcard `FJY7UPX884.*`;
- a **device list** with the UDIDs of the phones that should install it;
- an **expiry date** that's still in the future.

To check that it includes your certificate, compare SHA-1s:

```sh
openssl smime -inform der -verify -noverify -in <file> 2>/dev/null > /tmp/p.plist
python3 -c 'import plistlib,hashlib,sys; print([hashlib.sha1(c).hexdigest().upper() for c in plistlib.load(open(sys.argv[1],"rb"))["DeveloperCertificates"]])' /tmp/p.plist
security find-identity -v -p codesigning | grep 'Apple Development'
```

Then store it:

```sh
base64 -i ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/<UUID>.mobileprovision \
  | gh secret set IOS_PROVISIONING_PROFILE_BASE64 --repo boson-chat/boson
```

## How the job behaves

- **Certificate secrets missing**, or **no profile secret and no
  `APPLE_API_*` key**: a notice ("iOS build skipped"). The job succeeds
  and the release goes out without the iOS files.
- **The `.p12` doesn't import, holds no valid Apple Development identity,
  or no usable profile was found** (none active in App Store Connect, wrong
  app ID, expired, or missing the certificate): a warning, and the job
  skips the same way.
- **Otherwise** the job:
  1. imports the certificate into a temporary keychain, together with
     Apple's WWDR G3 intermediate;
  2. installs the profile;
  3. builds and signs the device app, and verifies the signature and the
     IPA's layout;
  4. uploads `Boson-ios.ipa` and `Boson-ios.plist`;
  5. deletes the keychain and the decoded files in an `if: always()` step.
- **A failure** never blocks a release. The job has `continue-on-error`
  and a 45-minute timeout, and `release-assets` doesn't wait for it to
  succeed.

On pull requests and `main`, the job also builds when the secrets are set,
but the IPA only goes to a workflow artifact. Pull requests from forks get
no secrets, so they skip.

## Locally

```sh
cd desktop
IOS_PLATFORM=device \
PROVISIONING_PROFILE=~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/<UUID>.mobileprovision \
IPA_OUT=/tmp/boson-ota \
IPA_BASE_URL=https://github.com/boson-chat/boson/releases/download/vX.Y.Z \
  ./scripts/package-ios.sh
```

With `PROVISIONING_PROFILE` set, no iPhone needs to be connected, and the
build never falls back to `ios_provision.py`. `CODESIGN_IDENTITY` picks a
particular identity, and `CODESIGN_KEYCHAIN` a particular keychain. To
regenerate only the manifest:

```sh
desktop/scripts/ios_ota.py --manifest-only --bundle-id chat.boson.app \
  --version X.Y.Z --out <dir> --base-url https://github.com/boson-chat/boson/releases/download/vX.Y.Z
```
