# Push notifications on iOS

Client side of [the push design](https://github.com/boson-chat/stack/blob/main/docs/push.md) (§3) for the iPhone app.

## How it fits together

- **`desktop/push.go`** (`PushService`, shared with Android) is what the renderer's push manager (`client/src/renderer/src/modules/push`) calls through `window.bosonPush`. For each server where push is offered, it:
  - reads `push.relay` from the server's `boson.json`;
  - generates a P-256 key pair and a 16-byte auth secret for this device and server;
  - gets the APNs device token;
  - fetches a challenge from the relay (`GET /v1/challenge`) and attests it;
  - creates a mailbox (`POST /v1/mailboxes`).

  The renderer then sends `WEBPUSH REGISTER <mailbox endpoint> p256dh=…;auth=…` to the server. Mailboxes are reused while they still match. When the device token rotates, the service sends `PATCH /v1/mailboxes/<id>` with the new token. If the server's VAPID key changes, the mailbox is replaced. Turning push off, signing out, or removing the server calls `DELETE /v1/mailboxes/<id>`.
- **`desktop/push_ios.go` / `push_ios.m`** hold the iOS parts:
  - The APNs token comes from `registerForRemoteNotifications`. The callbacks are added to Wails' app delegate from `main.m`.
  - The relay platform is `apns-sandbox`, or `apns` when the provisioning profile's `aps-environment` is `production`. `package-ios.sh` passes this in as `-X main.apnsEnvironment`.
  - App Attest: the first mailbox on an install sends an attestation, and later mailboxes send assertions. Development builds send `attestationType: "dev"` and rely on the relay's dev allowlist.
  - Each server's record (keys, mailbox id and secret) is a keychain item with service `chat.boson.push`. Its access group is the App Group `group.chat.boson.app`, so the extension can read it.
  - The notification settings are written to `push-prefs.json` in the App Group container.
- **`desktop/build/ios/push/`** is the Notification Service Extension (`BosonPush.appex`, bundle id `chat.boson.app.push`, Swift and CryptoKit):
  - It decrypts the RFC 8291 `aes128gcm` body with the stored key.
  - It parses the IRC line and applies the settings and channel levels, using the same rules as the renderer's `payload.ts` and `filter.ts`.
  - It shows "<nick> in #channel" or "<nick>" as the title, with the server name as the subtitle. `threadIdentifier` is `<server>:<conversation>`.
  - `MARKREAD` removes that conversation's notifications.
  - If a push can't be decrypted but its mailbox is known, it keeps the relay's generic "New message". Anything else is replaced with empty content. Fully dropping a push would need Apple's `com.apple.developer.usernotifications.filtering` entitlement, which requires Apple's approval.
- A tap goes through `notify_ios.m`, which reads `userInfo["boson"]`, then `bosonPushTapped`, then the `push:open` event or `ConsumeOpen` (for a cold start). The renderer opens that server and conversation once it's connected. While the app is in the foreground, push banners are suppressed because the app is connected and notifies by itself.

## What the relay must send (APNs)

```json
{
  "aps": { "alert": { "title": "New message" }, "mutable-content": 1 },
  "mailbox": "<mailbox id>",
  "payload": "<the Web Push body as received, base64>"
}
```

The extension also accepts `m` or `id` for the mailbox and `p` or `body` for the payload, in standard or URL-safe base64. Without a mailbox id, it tries every stored key; the AES-GCM tag rejects a wrong key.

## Relay API this client speaks

| Call | Request | Answer |
| --- | --- | --- |
| `GET /v1/challenge` | | `{"challenge": "<string>"}` (single use) |
| `POST /v1/mailboxes` | §2.1 body, plus `challenge`, `attestationType` (`app-attest`, `app-assert`, `play-integrity` or `dev`) and `keyId` (App Attest). `attestation` is base64. iOS signs `SHA-256(challenge)` as the clientDataHash. | `200/201 {"endpoint": "https://<relay>/v1/push/<id>", "secret": "…", "id"?: "…"}`. The endpoint must be on the relay's host. |
| `PATCH /v1/mailboxes/<id>` | `Authorization: Bearer <secret>`, `{"token": "…"}` | `2xx`. `404/410` makes the client create a new mailbox. |
| `DELETE /v1/mailboxes/<id>` | `Authorization: Bearer <secret>` | `2xx` (`404/410` are fine) |

Errors are read from `{"error"|"message": "…"}` and shown in Settings.

## What has to be set up in the Apple developer account

1. **App ID `chat.boson.app`**: enable Push Notifications, App Groups (add `group.chat.boson.app`) and App Attest.
2. **App ID `chat.boson.app.push`** (the extension): enable App Groups (`group.chat.boson.app`).
3. Regenerate the development (and distribution) provisioning profiles for both IDs. Xcode-managed profiles are picked up by `package-ios.sh`. CI takes the extension's profile from `PUSH_EXT_PROFILE`. Without a profile for the extension, it's left out and pushes show as "New message".
4. Create an APNs auth key (`.p8`). It goes to the relay, together with the Team ID and the bundle id, not into the app.

`package-ios.sh` only adds `aps-environment`, the App Group and the App Attest environment when the app's profile grants them. A profile made before this setup still signs and installs, without push (the build prints a note).

## Building and testing

- Simulator: `cd desktop && ./scripts/package-ios.sh`. Device: `IOS_PLATFORM=device ./scripts/package-ios.sh`.
- `desktop/scripts/test-ios-push.sh` runs the extension's decrypt, parsing and filtering on the Mac. It covers the RFC 8291 §5 vector, a body made by Ergo's own Web Push library (`desktop/testdata/webpush-ergo-vector.json`) and the renderer's test cases. CI runs it in the `ios-push-tests` job.
- Simulator builds take a server record and settings from the launch environment: `SIMCTL_CHILD_BOSON_PUSH_TEST_RECORD='{"v":1,"serverId":…,"private":…,"auth":…,"mailbox":…}'` and `…_PREFS`. That was meant for trying the extension with `xcrun simctl push`. However, `simctl push` delivers straight to SpringBoard without running service extensions (checked with Xcode 27 and an iOS 17.2 simulator: the original "New message" shows). So the end-to-end rewrite needs a real device and the relay.
