# Boson on iOS and Android

Status: **plan for review**. No code until it's agreed.
Starting point: main at 0.39.1 — the Wails v3 desktop app (`desktop/`, Go),
the renderer (`client/`, Preact), the Go engine (`engine/`, in-process).
The web-client plan (`docs/web-client.md`, draft #27) is parked; mobile goes
first.

Decided (2026-10-16): **Wails v3 mobile**, **iOS and Android together**,
plan (this doc) before building. Answers to the review questions:

- **App ID:** `chat.boson.app` on both (Android package and iOS bundle id),
  as on desktop. Apple ids are per developer account and may span macOS and
  iOS; the Mac app is outside the App Store, so nothing clashes. When the iOS
  app is in App Store Connect, untick "make available on Apple Silicon
  Macs", so a Mac never has two apps with the same id.
- **Minimum versions:** iOS 16+, Android 8.0 (API 26)+.
- **Tablets:** yes — iPad and Android tablets, with the desktop-style layout
  on wide screens and the mobile one on narrow ones (and in split view).
- **Android background:** the opt-in "Stay connected in the background"
  foreground service is in v1.
- **Push notifications:** not in v1.
- **Reports:** by email. Report opens a pre-filled email to
  `abuse@boson.chat` (network, channel, nick, the message, app version);
  the mailbox has to exist and be read. A backend moderation queue can come
  later.
- **Distribution for now:** no Google Play account yet. Android builds are
  sideloadable APKs signed with our own generated key (Android won't install
  a truly unsigned APK); Play comes later. iOS runs in the simulator; real
  iPhones need Apple signing, so TestFlight (the existing Apple account) when
  we want devices.

## Why Wails mobile

Wails v3 builds the same Go `main` and the same frontend for iOS (a
WKWebView in a UIKit host) and Android (a WebView; the Go code compiled as
`libwails.so` with the NDK). So the phone app is the desktop app's code:

- **The engine runs in-process with real TCP.** Unlike the browser (see the
  web plan), a native app can open sockets, so IRC works directly — no relay,
  nothing to host.
- **The Go services carry over** (API proxy, unfurl, Spotify, themes, the
  secure store's file format, the engine's transport), with per-platform
  pieces where the OS differs (below).
- **One renderer.** The work on the interface is a mobile layout, which the
  web version would reuse later.

### The risk we're taking

Wails' docs disagree on mobile's status: the main guide still marks it
**experimental** ("the API and build process may change significantly before
the final release"); the newer v3 pages don't. We're already on a Wails
beta (pinned, beta.30) for desktop, so this is the same bet, extended. We pin
the version, keep the mobile glue thin, and Phase 0 is a go/no-go.
Sources: [wails.io mobile guide](https://wails.io/docs/guides/mobile),
[v3.wails.io mobile overview](https://v3.wails.io/guides/mobile),
[iOS guide](https://docs-preview.wails.io/guides/mobile/ios/).

Fallback if Wails mobile doesn't hold up: Capacitor (a mature mobile webview
shell) running the same renderer, with the engine built by gomobile behind a
plugin. More native glue, same renderer.

## What already works (checked 2026-10-16)

- **iOS:** `desktop/` compiles for the iOS simulator (`GOOS=ios`, arm64,
  iOS 16 SDK target) unchanged — every service. Only the final link fails,
  for `_WailsIOSMain`, the entry point Wails' iOS project template provides
  (`main.m` / `main_ios.go`): scaffolding, not a code problem.
- **Android:** `desktop/` builds as an Android shared library
  (`GOOS=android`, arm64, `-buildmode=c-shared`) with the installed NDK
  (r23): 58 MB unstripped debug; a stripped release build will be a
  fraction of that.
- **Toolchains on the dev Mac:** Xcode with iOS 17.2 and 27.0 simulators;
  Android SDK, NDK r23, platform tools (no emulator image/AVD yet). Wails'
  Android template targets compileSdk/targetSdk 35, minSdk 21, and picks the
  newest installed NDK; we'll install a current NDK (r27+) and an emulator
  image in Phase 0.

## The app on a phone: service by service

| Piece | Desktop | iOS | Android |
|---|---|---|---|
| Engine | in-process, TCP | same | same |
| API proxy, unfurl, Spotify | Go | same | same |
| Secure store | file + key in the OS keychain (go-keyring) | **new:** key in the iOS Keychain via the Security framework (cgo `SecItem*`); go-keyring shells out to `/usr/bin/security`, which iOS doesn't have | **new:** key wrapped by the Android Keystore (JNI via Wails' Android bridge); go-keyring has no Android backend |
| Notifications | Wails service | Wails service has an iOS implementation (`UNUserNotificationCenter`) | **new:** NotificationManager + channel (Kotlin in the Android template, called over the bridge); Android 13+ needs the POST_NOTIFICATIONS permission |
| Deep links (`boson://`) | OS → second instance | URL scheme in Info.plist (+ universal links for `boson.chat/…` later) | intent filter in the manifest |
| Single instance | yes | n/a (the OS does it) | n/a |
| Updater | release check | none (App Store) | none (Play Store) |
| Title bar / window controls | custom | none; safe-area insets (`env(safe-area-inset-*)`) | none; edge-to-edge insets |
| Themes folder | files + watcher | app sandbox; no "open folder" | same |
| Opening links | default browser | SFSafariViewController / Safari | Custom Tabs / browser |
| YouTube wrapper | from boson.chat | same (WKWebView, as macOS) | check in Phase 0 (Android WebView) |
| Network sign-in discovery (boson.json `auth.url`) | Go (`NetAuthService`) | same | same |
| File uploads | Go (`FilesService`), 4 MiB ArrayBuffer chunks to `/_boson/files/` | same (WKWebView passes ArrayBuffer bodies whole) | same; untested on the Android WebView |
| Voice | QUIC + Opus (cgo audio: miniaudio) | same engine on the voice-processing audio unit (echo cancelled), see [Voice](#voice-on-ios-and-android) | same engine on miniaudio/AAudio as a voice call, see [Voice](#voice-on-ios-and-android) |
| "Sign in with …" (SSO) | loopback redirect listener | not yet (needs a `boson://` redirect) | same |

The renderer already reads the platform (`bosonPlatform`); it gains `ios`
and `android`, which switch the layout and hide desktop-only UI.

## The mobile interface

This is the biggest piece. Today's layout is a desktop window: server rail,
channel sidebar, chat and member list side by side; only three stylesheets
have any media queries. On a phone (and narrow windows generally):

- **One pane at a time:** servers → channels → chat, with the member list
  as a sheet/drawer. Back gesture / back button between them.
- **Touch, not mouse:**
  - long-press instead of right-click for the context menus;
  - tap instead of hover for member cards;
  - long-press drag for server-rail reorder;
  - 44 px minimum touch targets.
- **The composer and the keyboard:**
  - keep the input above the keyboard (`visualViewport`);
  - no iOS zoom-on-focus (16 px inputs);
  - mention/emoji pickers that fit.
- **Settings and modals** become full-screen sheets.
- **Safe areas and dark mode** follow the system.

Built as a responsive mode of the same components (a breakpoint plus
`ios`/`android`), not a separate app, so desktop narrow windows and the
future web version get it too.

## Backgrounding: the hard part of IRC on a phone

IRC is a persistent TCP connection; phones don't keep apps running:

- **iOS** suspends an app shortly after it leaves the screen; the IRC
  connection then times out. The audio background mode is only for audio
  the user hears: the app has it for voice calls (below), not for chat.
- **Android** allows a **foreground service** (with a persistent
  notification) to keep the connection, at a battery cost.

So for v1:

- On returning to the app, reconnect quickly and fill the gap: through the
  user's bouncer (ZNC/soju replay, which the app already handles) or
  IRCv3 chathistory where the server has it. Direct connections without
  either lose what was said while away, as on desktop after a sleep.
- Keepalive (`engine/irc/keepalive.go`): the engine PINGs after 60s of
  quiet, which keeps carrier NATs and the server's idle timer (Ergo: ping
  at 90s, drop at 150s) happy. Any bytes from the server count as alive.
  A connection is dropped only after three unanswered PINGs, 20s apart. A
  check on returning to the app or on a Wi-Fi/cellular switch uses the same
  retries with 10s waits. Silence while the app was suspended isn't
  counted. No IRC spec sets these numbers (RFC 1459/2812 say only "regular
  intervals"), and no ISUPPORT/CAP advertises a server's.
- Android: an opt-in "Stay connected in the background" setting (foreground
  service).
- iOS: the bouncer is the way to stay "present"; the app nudges users who
  want that towards the bouncer settings.
- **Push notifications** (mentions while the app is closed) need something
  always connected that can send through Apple's/Google's push services:
  e.g. the IRCv3 `draft/webpush` extension (soju and Ergo support it) via a
  small push relay. That's a server; **out of scope for v1**, listed as a
  follow-up.

## Voice on iOS and Android

Voice channels work on phones as on desktop: the same `VoiceService`
(`desktop/voice.go`) and quicvoice engine (Opus at 24 kbit/s on phones,
VAD/push to talk, jitter buffers, mixer) over QUIC to quicvoiced. Only the
audio device and the OS glue differ.

| | iOS | Android |
|---|---|---|
| Audio device | one `VoiceProcessingIO` audio unit, 48 kHz mono S16 (`voice_device_ios.m`): Apple's echo canceller, noise suppression and AGC | miniaudio on AAudio (OpenSL ES on 8.0), usage and input preset *voice communication*, so the platform's AEC/NS run where the device has them (`voice_device_android.go`) |
| Session / mode | `playAndRecord` + `voiceChat`, Bluetooth (HFP) allowed | `MODE_IN_COMMUNICATION` and audio focus while the device is open (`BosonVoice.java`) |
| Mic permission | `NSMicrophoneUsageDescription`; asked on the first join (or mic test) | `RECORD_AUDIO` at runtime, asked on the first join; denied → a message pointing at Settings |
| Speaker / earpiece | loudspeaker by default (`DefaultToSpeaker`); the call screen switches to the earpiece; headsets take over | the same, via `setCommunicationDevice` (API 31+; `setSpeakerphoneOn` before); Bluetooth SCO / wired headsets first |
| Interruptions | a phone call or Siri stops the unit; it restarts when they end (whether or not iOS suggests resuming); a media-services reset rebuilds it. The UI says "Paused while another call has the audio" | losing audio focus (a phone call) shows the same; AAudio streams are reopened by miniaudio after a route change |
| Background | `UIBackgroundModes: audio`: with the audio unit running the app keeps running (screen locked or another app open), and so do the IRC connections | a foreground service of type `microphone` (`BosonVoiceService`) with an ongoing "In voice: <room>" notification and a Leave action, while connecting or in a room |

The interface (`MobileVoice.tsx`): a call bar over the chat whatever
channel or server is open, with mute and leave as 44 px buttons; a tap
opens the call screen (a bottom sheet) with who's in and talking, mute,
deafen, speaker/earpiece (shows the headset when one has the sound), leave,
open mic or push to talk, and a hold-to-talk button in push-to-talk mode.
Tapping someone shows their volume slider. Open mic (voice activity) is the
default; Settings → Voice has the sensitivity and the mic test, no device
pickers.

What still drops or isn't there:

- The capture side keeps running while muted (the mic indicator stays on):
  stopping the voice-processing unit's input, or AAudio's input stream,
  would glitch the playback that shares it, and on iOS the running unit is
  what keeps the app alive in the background.
- Leaving the call in the background ends the reason to run there: iOS
  suspends the app a few seconds later (the scene delegate's ~30 s grace)
  and the IRC connections drop as without voice; Android stops the
  foreground service with the call (unless "Stay connected" runs its own).
- Swiping the app away (Android) or iOS killing it ends the call.
- A network change (Wi-Fi ↔ cellular) drops the QUIC connection: the call
  ends with "Lost the connection" and a Try again button; there's no
  automatic rejoin yet.
- The webview can be suspended in the background: the call goes on in Go,
  and the screen catches up on return.
- No push-to-talk from the lock screen or a headset button; push to talk is
  the on-screen button while the app is open.

Builds: `desktop/scripts/build-opus.sh` cross-compiles a static libopus per
target (`ios-device`, `ios-simulator`, `android-arm64`, `android-amd64`),
cached under `desktop/build/.opus`; `package-ios.sh` and
`package-android.sh` build it and link it in (`-tags nolibopusfile`).

## Video on iOS and Android

Every voice channel is also a video channel (quicvideo; see
`docs/design.md` and `docs/voice-merge.md` in boson-chat/quicvideo). On
phones, `VideoService` (`desktop/video.go`) runs as on desktop: a video
ticket from quicvoiced, a QUIC connection to quicvideod, and frames handed
to the webview over the loopback WebSocket, where WebCodecs decodes them.
Lip sync is the same too: video waits for its sound, and a person's audio
is delayed by up to 150 ms when their video arrives late.

| | iOS | Android |
|---|---|---|
| Watch | yes: the voice bar's video button opens the call view in place of the chat | yes, the same |
| Camera | front camera first, upright portrait; AVFoundation + VideoToolbox H.264 (quicvideo `client/media`) | front camera first, upright portrait; Camera2 NDK + `AMediaCodec` H.264 (hardware where the device has it) |
| Camera permission | `NSCameraUsageDescription`; asked the first time the camera is turned on | `CAMERA` at runtime, asked the first time the camera is turned on; denied → a message pointing at Settings |
| In the background | the camera stops (iOS interrupts capture), which ends the share; voice goes on | the same: Android takes the camera from a backgrounded app, the camera reports a disconnect and the share ends |
| Screen sharing | not yet (below) | not yet (below) |

Checked so far:
- iOS: the app builds, links and launches in the simulator (iPhone 15 Pro
  Max, iOS 17.2). The simulator has no camera, so capture needs a real
  iPhone.
- Android: the encoder round trip passes on the API 35 emulator (60/60
  frames, keyframes on request, SPS/PPS first); the APK installs and
  launches with the Camera2/MediaCodec libraries loaded. Capture in a real
  call is still to be checked on a device.

### Screen sharing on phones: the plan

Neither OS lets an ordinary app capture the screen. Both have a separate,
system-mediated path.

**iOS: a ReplayKit broadcast upload extension.**
- A second target in the app (`BosonBroadcast.appex`, a *Broadcast Upload
  Extension*), started from the call view through
  `RPSystemBroadcastPickerView` (the system's own sheet; the user picks
  Boson and taps Start Broadcast). In-app `RPScreenRecorder` capture
  isn't enough: it only sees our own app.
- The extension runs in its own process with a hard memory limit (about
  50 MB) and gets `CMSampleBuffer`s of the whole screen. It encodes them
  with VideoToolbox itself (no webview, no Wails, just quicvideo's Go
  client built as a small library) and publishes a `SCREEN` track.
- It needs its own video ticket: the app writes a short-lived one, plus the
  quicvideod address, to an App Group (shared container and keychain
  group) when the call starts and refreshes it; the extension reads it and
  dials quicvideod directly. The app stays in the call for audio.
- The broadcast ends when the user stops it from the status bar or Control
  Centre, or when the call ends (the extension sees the ticket withdrawn
  and calls `finishBroadcastWithError`).
- Work: the extension target and its provisioning profile (App Group
  entitlement on both), a c-archive build of the publisher for it, the
  picker button in the call view, and keeping memory under the limit
  (one layer at 720p, small encoder queue).

**Android: MediaProjection.**
- The call view's screen button starts
  `MediaProjectionManager.createScreenCaptureIntent()`, so the system's
  consent dialog appears every time (Android 14 requires consent per
  session).
- Before using the projection, a foreground service of type
  `mediaProjection` must be running (`FOREGROUND_SERVICE_MEDIA_PROJECTION`,
  API 34). `BosonVoiceService` is already the call's foreground service; it
  would add that type while sharing.
- The projection's `VirtualDisplay` renders straight into the input
  `Surface` of an `AMediaCodec` encoder (`AMediaCodec_createInputSurface`),
  so frames never pass through Go memory. The encoder's output goes to the
  same publisher as the camera's.
- The share ends when the user stops it from the notification or the
  system's cast tile (`MediaProjection.Callback.onStop`), or when the call
  ends.
- Work: the Java side (intent, result, service type), a surface-input
  encoder in quicvideo `client/media` (`media_android.go`), and the button.

Both are their own PRs when we decide to do them. Until then, the screen
button is hidden on phones (`VideoState.canShareScreen`).

## Store requirements that affect the app

- **Apple (App Store Review 1.2, user-generated content):** a chat app must
  let users **block abusive users**, **report** content, filter
  objectionable material, and publish a way to contact us; it also needs an
  EULA with zero tolerance for abuse. The app has `/ignore`-style commands
  but needs visible Block and Report actions (report = a message to us with
  the network/channel/nick and message, plus `/ignore` locally).
- **Privacy:** App Store privacy labels and Google Play Data safety forms
  (what the backend stores: account, encrypted identity, directory data).
  The apps also send an anonymous daily **usage & health stats** ping
  (random device ID, app version, platform, channel, crash count, a bucketed
  server count; on by default, Settings → Privacy → Usage & health stats
  turns it off): declare it as anonymous analytics / crash data not linked
  to the user. Spec: boson-chat/stack `docs/telemetry.md`; public page:
  https://boson.chat/telemetry; code: `client/src/renderer/src/modules/telemetry`.
- **Accounts:** if sign-up is in the app, **account deletion** must be in the
  app too (Apple 5.1.1(v), Google Play policy). Check the backend has it.
- **Licence: the App Store and the AGPL.** Boson, quicvoice and quicvideo
  are AGPL-3.0. Apple's App Store terms add restrictions the GPL family
  forbids passing on (the usage rules, a limit on the number of devices, no
  redistribution of what you downloaded). This is why the FSF objected to
  VLC in the App Store in 2011 and it was removed. In short:
  - **Code we own** we can publish on the App Store as we like: the
    licence binds people we give the code to, not its copyright holders.
    The risk is **code we don't own**: AGPL/GPL contributions from others,
    and any GPL-family dependency in the iOS build. Any of those authors
    could object, and Apple removes apps on a copyright complaint.
  - **What to do before the first App Store submission:**
    1. List the iOS build's dependencies and their licences.
       `go-licenses report` covers the Go side; libopus is BSD; check
       the rest.
    2. Add an **additional permission** under AGPL §7 to the three repos,
       allowing distribution through app stores whose terms add such
       restrictions, provided the source stays available.
    3. Get every outside contributor's agreement to it, or a CLA from
       here on.
    4. Offer the source in the app: AGPL §13 requires it for network use
       anyway. For example, a link in Settings → About to the repos at the running version.
  - **Google Play** adds no such restriction, so only §13 and the usual
    source offer apply there.
  - This isn't legal advice; settle it before submission, not after a
    takedown.
- **Encryption export compliance:** standard HTTPS/TLS → the usual
  exemption declaration.

## Build, signing, release

- **Layout:** `desktop/` stays the one Go app; it gains `main_ios.go` /
  `main_android.go` entry glue and `build/ios`, `build/android` projects
  from Wails' templates (adapted: name, bundle id, icons, scheme). The
  desktop builds are unaffected.
- **iOS:** Xcode build on the macOS runner; signing with the existing Apple
  Developer team (FJY7UPX884) — needs an iOS distribution certificate and an
  App Store provisioning profile; upload to TestFlight with the App Store
  Connect API key we already use for notarization.
- **Android:** Gradle build on Linux; for now a sideloadable **APK** signed
  with our own release key (a new CI secret), attached to each GitHub
  Release. Later, with a Play Console account: an AAB and Play App Signing.
  Built by `desktop/scripts/package-android.sh` (arm64; `ARCHS="arm64 amd64"`
  adds x86_64 for emulators and Chromebooks, `RUN=1` installs it with adb).
- **CI:** the Android APK is a job in `desktop.yml`: built on every PR, and
  on release tags attached to the GitHub Release as `Boson-android.apk`
  when it was signed with the release key (secrets `ANDROID_KEYSTORE`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`).
  The `ios` job builds a development-signed IPA for the registered test
  devices and attaches it with an over-the-air install manifest
  (`Boson-ios.ipa`, `Boson-ios.plist`; [ios-release.md](ios-release.md)).
  Still to come: an iOS simulator build on PRs and the TestFlight upload.
  Store submission stays manual.
- **Versions:** iOS 16+, Android 8.0 (API 26)+ (decided).

## Testing

- **Renderer:** unit tests for the mobile layout's state (navigation stack,
  long-press menus, insets) like the existing component tests.
- **E2E:** the existing real-app suite runs against the server-mode build
  in Chromium; it gains **mobile viewport projects** (iPhone and Pixel
  emulation, touch enabled) — cheap, and it covers the layout and flows.
- **Native smoke tests** on simulator/emulator (Maestro or XCUITest/Espresso)
  for what only the device has: launch, secure store, notifications, deep
  links, background/resume reconnect. Phase 4.
- **Manual checklist** per release: real devices, keyboard handling,
  backgrounding.

## Phases

### Phase 0: spike (go/no-go, ~3–4 days)
1. Wails' iOS template wired to `desktop/`: the app launches in the iOS
   simulator, the engine connects to the local ergo, a channel works.
2. The same on an Android emulator (install a current NDK and an AVD).
3. YouTube embed and link opening in both webviews.
4. Background/resume on both: how fast the reconnect and replay feel.
5. Release-build sizes.

### Phase 1: platform services (~1–2 weeks)
- Secure store backends: iOS Keychain, Android Keystore.
- Notifications on Android; iOS via the Wails service.
- Deep links, link opening, insets; `bosonPlatform` = `ios`/`android`.
- Lifecycle: pause/resume hooks → engine reconnect; Android foreground
  service (opt-in).

### Phase 2: the mobile interface (~2–3 weeks)
- Single-pane navigation, sheets, long-press menus, touch targets, keyboard
  handling, safe areas; desktop narrow windows get it too.
- Block and Report actions (store requirement).

### Phase 3: tests and CI (~1 week)
- Mobile viewport e2e projects; native smoke tests; `mobile.yml`.

### Phase 4: signing and beta (~1 week)
- Android release key; APKs on GitHub Releases from release tags.
- iOS certificates/profiles and TestFlight from release tags (when we want
  real devices); the `abuse@boson.chat` mailbox; EULA and privacy text.

### Phase 5: store release (later)
- Google Play Console account; App Store listing; review feedback; public
  release on both stores.

Rough size: 7–9 weeks. The interface is the largest part; the Go side is
mostly done already.

## Still open

- The `abuse@boson.chat` mailbox (or another address) — needs creating.
- When to start TestFlight (needs an iOS distribution certificate and an App
  Store Connect app record under the existing team).
