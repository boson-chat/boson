# Migrating the desktop client from Electron to Wails v3

Status: **plan for review**. No app code changes until it's agreed.
Pinned to `github.com/wailsapp/wails/v3 v3.0.0-beta.30` (2026-10-15).
Starting point: main at 0.36.4 on Electron 44.7, electron-vite and electron-builder.

## Why, and what doesn't change

Wails replaces Chromium and Node with the OS webview and a Go process. The
native shell moves from TypeScript to Go, next to the Go engine, which stays a
separate process. The expected gains are size (about 200 MB per DMG today),
memory, and one language for everything native.

The renderer stays: the Preact app, its ~30k lines and its 130 unit-test files.
Today it reaches native code only through 10 `window.boson*` bridges, with
26 IPC channels in total. The plan is to keep those bridge interfaces exactly as
they are and back them with Wails bindings. Then the migration happens almost
entirely below the renderer.

## Wails v3 status (the risk we're accepting)

- **Release status:**
  - Still beta: 30 betas in about 10 weeks, often 2 or 3 a week.
  - The GA milestone was due 2026-09-15. It was missed and still has 16 open
    issues.
  - Wails v2 is still the official stable line.
- **Breaking changes keep landing during the beta**, for example:
  - beta.19 moved private macOS APIs behind a build tag;
  - beta.20 removed the native WebView2 loader;
  - beta.30 dropped two macOS window events.
- **Policy:**
  - Pin one beta.
  - Bump deliberately, with the full test pass, never `@latest`.
  - Keep shipping Electron from main until the Wails build has passed rollout
    (Phase 7).
- **Docs:** several Wails doc pages are placeholders or contradict the code,
  including "From Electron", Windows cross-signing and the page origin. Check
  behaviour against the source at the pinned tag.

## What has to be replaced

The inventory was taken from main at `0959852`.

| Electron today | Wails v3 replacement | Notes |
|---|---|---|
| `BrowserWindow`: 1280×800, min 900×600, `hiddenInset` with traffic lights at 16,9; frameless on Windows/Linux | `WebviewWindowOptions`. macOS uses `MacTitleBarHiddenInset`; Windows/Linux use `Frameless` | No traffic-light position API (wails#4227), so adjust the TitleBar padding instead. `-webkit-app-region` becomes `--wails-draggable`. |
| `bosonWindow` (min/max/close/show/isMaximized/onMaximizedChange), `bosonPlatform` | Window service plus window events | 1:1 |
| Single-instance lock and `second-instance` | `Options.SingleInstance` (with `EncryptionKey`) | Second-instance args are untrusted, so parse strictly, as today. |
| `boson://` deep links: `open-url` on macOS, argv elsewhere, buffered until the renderer consumes them | `protocols:` in `build/config.yml` plus `ApplicationLaunchedWithUrl`. On a warm start on Windows/Linux the URL arrives in `OnSecondInstanceLaunch` args | Keep the same buffer/consume/dedupe in the bridge. The Linux `.desktop` task drops the MIME type (wails#6252), so customise it. |
| Engine sidecar: spawned binary, loopback WebSocket with a token, restart with backoff | **Still a sidecar**, supervised by the Wails app (a Go port of `engine.ts`) | See "Engine" below. |
| `bosonSecure`: `identity-store.json`, values `ks1:` (safeStorage) or `fb1:` (derived key) | Same file format. The AES-GCM master key is kept in the OS keychain via `zalando/go-keyring` | Wails has no desktop secure store. go-keyring caps a Windows credential at about 2.5 KB, so only the 32-byte key goes there, not the values. |
| `bosonApi`: CORS-free proxy to api.boson.chat with an allowlist, a manual redirect walk and credential stripping on cross-origin hops | Go service, ported with its tests | The page's origin becomes `wails://localhost`, so the proxy is still needed. |
| `bosonUnfurl` (OG fetch, SSRF host guard, LRU) and `bosonSpotify` (embed `__NEXT_DATA__`) | Go services | Straight ports. The SSRF guard is the security-sensitive one. |
| `bosonThemes`: `<userData>/themes/*.json` plus a watcher | Go service plus `fsnotify` | |
| `bosonUpdater` (electron-updater, GitHub feed, states shown in Settings → About) | See "Updates" | |
| HTML5 `Notification`, permission granted by main; a click restores the window and opens the conversation | The Wails `notifications` service, with clicks handled by `OnNotificationResponse` | The webview `Notification` permission only works on Windows, so it has to go native. Use the same `tag` (server:channel). |
| Permission handler: allow notifications, fullscreen and clipboard-write; deny camera, mic, geolocation and the rest | `WebviewWindowOptions.Permissions`, all set to Deny | Notifications go native, as above. |
| `setWindowOpenHandler` / `will-navigate`: deny, and send http(s) links to the browser | **No API for this** (wails#5799, wails#5043 is 3.1) | Intercept `<a>` clicks and `window.open` in the renderer and call `Browser.OpenURL`. The CSP and a navigation guard script cover the rest. `security.spec` has to prove it. |
| Loopback HTTP server for the renderer (persisted port), and the `youtube-embed.invalid` wrapper | The embedded asset server: `wails://localhost` on macOS/Linux, `http://wails.localhost` on Windows | YouTube rejects embeds on a bad origin (Error 153). See Phase 0. |
| Chromium switches (`lang=en-US` for Spotify, a host-resolver rule) | — | Not applicable. |
| electron-builder: DMG and zip (x64, arm64, notarized), NSIS (unsigned), AppImage and deb | Wails Taskfile: `.app`, DMG, NSIS, AppImage, deb | The DMG itself has to be signed and notarized by hand; Wails only notarizes the `.app`. |

## Key decisions (recommendations; please confirm or change)

1. **Where the code lives**
   - New `desktop/` directory with its own `go.mod`, which uses a `replace` to
     the root module so it can import `engine/`.
   - That keeps Wails' cgo/webview dependencies out of the backend's builds and
     out of `go test ./...`.
   - The renderer stays in `client/src/renderer`. The Wails frontend build
     points at it, and a `bridge/wails.ts` shim installs the `window.boson*`
     globals from bindings.
   - `client/src/main` and `preload` are deleted only at the end.
2. **Engine (decided: stays a separate process)**
   - The engine remains its own binary, spawned and supervised by the Wails app
     exactly as Electron does today:
     - a free loopback port and a random token;
     - `serve --token-from-env`;
     - restart with backoff (0.5 s up to 10 s, reset after 30 s up).
   - That's a small Go port of `client/src/main/engine.ts`. The binary is still
     built per OS/arch, signed on macOS, and bundled in the `.app` /
     installer.
   - The renderer↔engine boundary stays the existing JSON-over-WebSocket
     protocol (`engine/ipc/protocol.go`). Nothing about it becomes
     Wails-specific: no bindings, no `HandleStream`.
   - **Why:** the long-term direction is to compile the engine to WebAssembly
     and deploy the frontend to the web, outside Wails. Keeping the engine
     behind a transport-level protocol, rather than Go bindings, keeps that open.
     That work is out of scope here. This plan just mustn't close it off.
   - The only change is that the engine's WebSocket `OriginPatterns` gains the
     Wails origins (`wails://localhost`, `http://wails.localhost`).
3. **Updates**
   - Use the Wails built-in `app.Updater` with the GitHub provider and **our own
     signature enforcement**.
   - It is currently fail-open (wails#6186): a configured public key doesn't
     make signatures mandatory. Wrap the provider so a release without a valid
     ed25519 signature is refused, until #6186 is fixed upstream.
   - The alternative is `creativeprojects/go-selfupdate`, which was the earlier
     choice before Wails gained an updater. It has the same `.app`-in-zip
     constraints and more code of our own.
   - Artifacts: macOS ships a signed, notarized, stapled `.app` in a zip (via
     `ditto`). Windows ships a per-user NSIS install
     (`WAILS_INSTALL_SCOPE=user`), because otherwise a non-elevated swap fails.
4. **Linux baseline**
   - The default is GTK4 with WebKitGTK 6.0, which needs Ubuntu 24.04+ or
     Debian 13+.
   - `-tags gtk3` uses WebKit2GTK 4.1 for older distros, but it is removed in
     3.1.
   - Recommendation: ship GTK4 only, and say so in the release notes.
   - AppImage built on Ubuntu currently crashes on other distros (wails#6213).
     Ship deb first, and AppImage once that's fixed.
5. **Existing users' data**
   - As decided earlier: one final Electron release exports, and the Wails app
     imports on first launch. Details are in Phase 6.
   - Origins change, so nothing in localStorage or IndexedDB carries over on its
     own.

## Phases

### Phase 0: spikes (go/no-go, about 1 week)
Build a throwaway Wails app that loads today's renderer build, then answer each
of these on macOS, Windows and Linux. Each result goes back into this doc.

1. **YouTube embeds from `wails://localhost`**
   - Check whether they play.
   - If not, try these in order:
     - the wrapper page served from a loopback http listener in the Go process;
     - a click-to-open-in-browser card (no new UI loaded from boson.chat).
2. **Supabase from the new origins**
   - Check that auth, realtime and storage work when called directly from the
     webview (CORS and wss).
3. **api.boson.chat:** the Go proxy round trip, including redirects.
4. **Notifications**
   - Send one and click it: the app should restore and open the conversation,
     with a signed bundle on macOS.
   - Check the Windows toast activator.
5. **Deep links:** cold and warm starts on all three OSes, including
   `boson://auth/confirmed`.
6. **Bridge update path from Electron to Wails**
   - Can the last Electron release's electron-updater install the Wails build?
   - macOS: Squirrel.Mac installs any `.app` in the zip that has the same team
     ID and bundle ID (`chat.boson.app`).
   - Windows: it runs the new NSIS installer.
   - Linux: it replaces the AppImage.
   - If this works, users get Wails without a manual download.
7. **E2E harness:** Playwright against the Wails server build (`-tags server`)
   in Chromium on Linux, for one existing spec end to end.
8. **WKWebView specifics**
   - IndexedDB performance with 10k+ history rows.
   - `devicePixelRatio` on a custom scheme (wails#5111).
   - Clipboard.
   - The markdown, KaTeX and mermaid rendering added in #17.

**Exit:** all of these pass or have an agreed fallback. If YouTube, Supabase or
the bridge update fail without a fallback, we stop and stay on Electron until
GA.

### Phase 1: scaffold (about 1 week)
- **`desktop/` app:**
  - A Wails app, pinned to beta.30, with its own `go.mod` and the Taskfile from
    `wails3 init -t vanilla-ts` adapted to the existing Vite config: Preact
    preset, CSP and dev engine discovery.
  - A window matching today's: size, min size and title bar.
  - A `Browser.OpenURL` link guard.
- **`bridge/wails.ts` shim:** installs the 10 `window.boson*` globals from
  generated bindings and events. Each starts as a stub that throws "not
  implemented".
- **Build and CI:**
  - `make desktop` / `npm run desktop:dev` (`wails3 dev`).
  - A CI job that builds `desktop/` on all three OSes, without signing yet.
- **Exit:** the app launches, shows the directory and connects to IRC through
  the engine sidecar it spawned.

### Phase 2: native services (about 2 to 3 weeks)
Port in this order, each with Go unit tests ported from `client/src/main/*.test.ts`:

1. Engine supervisor (sidecar spawn, discovery via the `bosonEngine` bridge,
   restart with backoff) and window controls.
2. Secure store: same file, the master key in the keychain, the `ks1:`/`fb1:`
   readers kept for import.
3. API proxy, unfurl and the SSRF guard, Spotify.
4. Deep links and single instance.
5. Notifications.
6. Themes and the watcher.
7. Updater (wired, but pointed at a test feed).

**Exit:** day-to-day use on all three OSes with nothing stubbed.

### Phase 3: tests (about 2 weeks, in parallel with late Phase 2)
- **Unit tests:** the 130 renderer files are unchanged. The main-process unit
  tests become Go tests.
- **E2E**
  - Run the existing 36 Playwright specs against the **Wails server build**
    in Chromium on Linux, with the same docker stack (ergo, ZNC, Supabase and
    the rest).
  - Replace the Electron-only hooks with an `e2e`-build-tag Go service:
    - `openedExternally` recorder;
    - API stub;
    - deep-link delivery (replacing `app.emit('open-url'|'second-instance')`);
    - user-data dir access;
    - engine PID lookup (the sidecar kill/restart specs keep working, since the
      engine is still its own process).
  - About 13 specs need edits.
- **Native smoke**
  - Windows CI via WebView2 CDP (`--remote-debugging-port`) and Playwright
    `connectOverCDP`: launch, sign in, chat, notification, deep link.
  - macOS: a short manual checklist per release, or the experimental Wails MCP
    harness once it's reliable (wails#6136).
- **Lost coverage, explicitly:** WKWebView and WebKitGTK aren't automated in CI.
  This is the biggest testing regression, and the native smoke and the
  checklist are the mitigation.

### Phase 4: packaging and release (about 1 week)
- **macOS**
  - `.app` builds for arm64 and amd64.
  - Sign with the existing Developer ID, hardened runtime, notarize, staple.
  - DMG, signed and notarized by hand.
  - The update zip, made with `ditto`.
  - Wails only supports `notarytool` keychain profiles, so CI runs
    `notarytool store-credentials` from the existing App Store Connect API key
    secrets.
- **Windows:** per-user NSIS installer, unsigned as today. Signing has to be
  done on Windows; cross-OS signing in Wails is a stub.
- **Linux:** deb for amd64 and arm64. AppImage later.
- **Release workflow:** a new `release-desktop.yml` alongside
  `release-client.yml`, on the same tags. It uploads the artifacts plus the
  signed update manifest. Both pipelines run until rollout ends.

### Phase 5: updater (inside Phase 4)
- **Feed and keys**
  - GitHub provider with a SHA256SUMS asset and an ed25519-signed manifest.
  - The key is generated once and kept with the other signing material, and
    gets a backup (still an open item for `~/.config/boson-signing`).
- **Enforcement:** refuse any update without a valid signature (our wrapper
  around wails#6186).
- **UI:** keep the Settings → About states and copy (`checking`, `downloading N%`,
  `restart to apply`). Use `updater.WindowNone`, so there's no Wails update
  window.
- **Tests**
  - Unsigned, wrong-key and truncated artifacts are rejected.
  - On macOS, an update while running from a translocated or read-only
    location fails with a clear message.

### Phase 6: migrating existing users (about 1 week)
- **Final Electron release (0.x, "bridge")**
  - On every quit and before applying an update, it writes
    `<userData>/migration/electron-export.json`, mode 0600, containing:
    - all `boson:*` / `boson.*` localStorage keys and the Supabase session key;
    - the IndexedDB `boson-chat-history` rows;
    - the themes folder;
    - the secure-store values, decrypted.
  - Its updater then installs the Wails build, if spike 6 succeeded. Otherwise
    About shows "download the new version".
- **Wails first launch**
  - If the export exists and nothing has been imported yet, the bridge imports
    it before the renderer boots: localStorage first, then IndexedDB in
    batches, then the secure store re-encrypted under the new key.
  - It then overwrites and deletes the export, and writes an
    `imported-from-electron` marker.
- **Secrets on disk:** decrypted secrets sit on disk only between the quit and
  the next launch. The identity is still password-wrapped. The bouncer and
  services credentials aren't, so they're the reason the file is 0600 and
  deleted right away.
- **Tests:** an e2e test that seeds a real Electron profile, runs the export,
  launches Wails and checks the session, servers, history, themes and secrets.

### Phase 7: rollout
1. Internal builds on our own machines for a week, on all three OSes.
2. Ship the bridge Electron release and the first Wails release together. The
   Electron pipeline stays available for a hotfix.
3. After two clean releases, delete `client/src/main`, `preload`, electron-vite,
   electron-builder and the Electron e2e fixture, and update the website's
   download and docs pages (data path, Linux requirements).

## Rough size
6 to 8 weeks of focused work. Phase 0 can stop it early. The largest parts are
the e2e harness (Phase 3) and migration (Phase 6), not the native ports, which
are about 2k lines of TypeScript becoming Go.

## Open questions for review
- Accept GTK4-only Linux (Ubuntu 24.04+ / Debian 13+)?
- Wails built-in updater with our signature enforcement, or go-selfupdate?
- Is a manual macOS checklist per release acceptable until WKWebView can be
  automated?
- If YouTube can't play from the new origin, is "open in browser" acceptable?
