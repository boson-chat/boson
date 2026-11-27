# Push notifications on Android

The design is in boson-chat/stack `docs/push.md`. This page covers the
Android app's part of it and what has to be set up before it works.

## How it fits together

- The renderer's push manager (`client/src/renderer/src/modules/push/`)
  calls `window.bosonPush`. On phones that is `platform/native-push.ts`,
  which calls `desktop/push.go` (`PushService`). For each server, `PushService`
  looks up the relay in the server's `boson.json`, generates a P-256 key and
  an auth secret, and creates a relay mailbox with the device's FCM token and
  a Play Integrity token. The mailbox URL is the endpoint the renderer sends
  to the server with `WEBPUSH REGISTER`.
- `desktop/push_android.go` is the Android `pushPlatform`. It calls Java
  through JNI (`push_android.c`) with one entry point,
  `BosonPush.call(op, arg)`, which returns JSON.
  - `BosonPush.java` (always built) stores each server's record in
    `EncryptedSharedPreferences` (`boson_push`, keyed by server id, with a
    Keystore-backed key). The record holds the private key and auth secret.
    It also stores the renderer's notification settings in the plain
    preferences file `boson_push_prefs`, and passes notification taps to Go,
    which opens the buffer.
  - `FcmBackend.java` (in `src/fcm/java`, Firebase builds only) gets the FCM
    token and the Play Integrity token.
  - `BosonPushService.java` (in `src/fcm/java`) receives FCM data messages.
    For each message it:
    1. decrypts the body with RFC 8291 / aes128gcm (`PushCrypto`),
    2. parses the IRC line (`PushLine`, which mirrors `payload.ts`),
    3. applies the settings (`PushFilter`, which mirrors `filter.ts`),
    4. posts one notification per conversation (tag `<serverId>:<conversation>`,
       grouped per server, with the server name as sub-text).

    A `MARKREAD` takes the notification down, `PING webpush` shows nothing,
    and a push no stored key decrypts is dropped. While the app is on screen,
    the page shows its own notifications instead.
- `PushCrypto`, `PushLine` and `PushFilter` are plain Java and run on the
  desktop JDK: `desktop/scripts/test-android-push.sh`. That test uses the
  RFC 8291 test vector, a body produced by Ergo's own library
  (`desktop/testdata/webpush-ergo-vector.json`), and the same cases as the
  renderer's tests.

## The build flag

FCM is on when `desktop/build/android/app/google-services.json` exists.
`-PbosonFcm=1` also turns it on, but without the JSON Firebase can't
initialise at run time, so that is only good for compile checks. When FCM is
on, the build:

- applies the `com.google.gms.google-services` plugin (only when the JSON is
  present),
- adds `firebase-messaging` (via the Firebase BoM) and
  `com.google.android.play:integrity`,
- compiles `src/fcm/java`,
- declares `BosonPushService` in the manifest (`${bosonPushService}`).

Without the flag the APK is built as before. The manifest then declares a
disabled stub service, and Settings → Notifications shows push as
unavailable ("This build has no push (built without Firebase).").

```sh
cd desktop
./scripts/package-android.sh                          # no google-services.json: no push
cp ~/secrets/google-services.json build/android/app/  # then: with push
BOSON_CLOUD_PROJECT=123456789012 ./scripts/package-android.sh
```

`google-services.json` is not a secret in the strict sense, but it is
specific to the project. Keep it out of the repository and have CI copy it
in from a secret.

## What has to be set up (by a person, once)

1. **A Firebase project** for the app, with an Android app whose package
   name is `chat.boson.app`. Download its `google-services.json` into
   `desktop/build/android/app/`.
2. **The relay gets FCM's credentials, the app doesn't.** In the Firebase
   console, create a service account with the Firebase Cloud Messaging API
   (HTTP v1) enabled and give its JSON key to the push relay at
   push.boson.chat (boson-chat/pushrelay configuration). The app holds no
   key.
3. **Play Integrity.** Link the Google Cloud project to the app in the Play
   Console (App integrity → Play Integrity API) and enable the Play
   Integrity API in Google Cloud. Build with
   `BOSON_CLOUD_PROJECT=<project number>` (or `-PbosonCloudProject=`).
   Integrity tokens are decrypted and verified on the relay through Google's
   `decodeIntegrityToken` API (or with the response encryption keys from
   the Play Console), so the relay needs a service account allowed to do
   that.
4. **Signing certificate.** Register the SHA-256 fingerprint of the release
   signing key (`ANDROID_KEYSTORE_FILE`, see `package-android.sh`) with the
   Firebase app. If Play App Signing is used, also register Play's app
   signing key. The relay checks `appIntegrity.certificateSha256Digest`
   against the same fingerprints.
5. **Development builds** (`DEV=1`) send the attestation type `dev` with no
   token. The relay must run its dev allowlist mode to accept them.

## The relay contract (what this client expects)

- `GET /v1/challenge` returns `{"challenge": "<string>"}`.
- `POST /v1/mailboxes` takes the body from docs/push.md §2.1:
  `{"platform": "fcm", "token", "app": "chat.boson.app", "attestation",
  "vapid", "install"}`, plus `"attestationType": "play-integrity" | "dev"`
  and `"challenge"`. It returns `{"endpoint", "secret"}` (optionally `"id"`;
  otherwise the endpoint's last path segment is used).
- `PATCH /v1/mailboxes/<id>` takes `{"token"}` and `DELETE /v1/mailboxes/<id>`
  removes the mailbox. Both use `Authorization: Bearer <secret>`.
- **The Play Integrity nonce** is the challenge itself when it is already
  URL-safe base64 of 16–500 characters. Otherwise it is the challenge's UTF-8
  bytes in URL-safe base64 without padding (`FcmBackend.nonceFor`). The
  relay compares `requestDetails.nonce` the same way.
- **The FCM message** is a data-only message with high priority. Its data
  holds:
  - `payload`: the whole aes128gcm request body as Ergo POSTed it, in
    base64 (standard or URL-safe, padded or not). `p` and `body` are also
    accepted.
  - `mailbox`: the mailbox id, so the app knows which key to use. `m` and
    `id` are also accepted. If the mailbox id is missing, every stored key
    is tried.

  FCM data is limited to 4 KB in total, so keep the key names short if the
  body comes close to that.
