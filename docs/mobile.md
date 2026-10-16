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
  connection then times out. Background modes for VoIP/audio aren't
  allowed for chat.
- **Android** allows a **foreground service** (with a persistent
  notification) to keep the connection, at a battery cost.

So for v1:

- On returning to the app, reconnect quickly and fill the gap: through the
  user's bouncer (ZNC/soju replay, which the app already handles) or
  IRCv3 chathistory where the server has it. Direct connections without
  either lose what was said while away, as on desktop after a sleep.
- Android: an opt-in "Stay connected in the background" setting (foreground
  service).
- iOS: the bouncer is the way to stay "present"; the app nudges users who
  want that towards the bouncer settings.
- **Push notifications** (mentions while the app is closed) need something
  always connected that can send through Apple's/Google's push services:
  e.g. the IRCv3 `draft/webpush` extension (soju and Ergo support it) via a
  small push relay. That's a server; **out of scope for v1**, listed as a
  follow-up.

## Store requirements that affect the app

- **Apple (App Store Review 1.2, user-generated content):** a chat app must
  let users **block abusive users**, **report** content, filter
  objectionable material, and publish a way to contact us; it also needs an
  EULA with zero tolerance for abuse. The app has `/ignore`-style commands
  but needs visible Block and Report actions (report = a message to us with
  the network/channel/nick and message, plus `/ignore` locally).
- **Privacy:** App Store privacy labels and Google Play Data safety forms
  (what the backend stores: account, encrypted identity, directory data).
- **Accounts:** if sign-up is in the app, **account deletion** must be in the
  app too (Apple 5.1.1(v), Google Play policy). Check the backend has it.
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
- **CI:** a `mobile.yml` workflow like `desktop.yml`: builds on every PR
  (an iOS simulator build and the Android APK); on release tags it attaches
  the APK to the GitHub Release, and — once we want devices — uploads the
  iOS build to TestFlight. Store submission stays manual.
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
