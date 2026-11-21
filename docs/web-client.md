# Boson in the browser: chat.boson.chat

Status: **built** (decided by James, 2026-11-21; boson#127). This replaces the
October plan (the engine relayed through the boson.chat Cloudflare Worker,
the app at boson.chat/chat): the stack now runs on our own VPS, so the
gateway, the static app and the call servers live there too.

## Goal

The whole app in a browser at **https://chat.boson.chat**: accounts and
guests, any IRC network, the directory, friends, uploads, themes, voice and
video calls. It is the same renderer (`client/`) the desktop and phone apps
run, with the same components and design system: no web-only restyling.
Self-hosters get it from the stack's `web` profile at their own `WEB_HOST`.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Engine | **The Go engine compiled to WebAssembly** (`GOOS=js GOARCH=wasm`), in a dedicated Web Worker | Reuses all of `engine/` (IRC, CAP/SASL, bouncer detection and replay, services automation, send queue, keepalive) and its tests, unchanged. It compiles as is (checked). A TypeScript port would rewrite ~5,000 lines and duplicate ~4,000 lines of tests, then drift. |
| IRC transport | **WebSocket → webircgateway → TCP/TLS**, for every network | Browsers can't open TCP. One dialer in the engine, one place for limits and WEBIRC. |
| Boson's own Ergo | **Through the gateway too**, not Ergo's native WebSocket listener | One code path for every network (the e2e suite tests the path third-party networks use), the gateway's per-IP limits and abuse controls cover our network as well, and Ergo still sees the real user IP via WEBIRC from the trusted gateway. The gateway reaches Ergo on the compose network (no hairpin through Traefik). The `wss://irc.boson.chat/webirc` route stays for other WebSocket clients. |
| Calls | **WebTransport** straight to quicvoiced (new) and quicvideod (has it) | No WebRTC gateway to run. Datagrams for Opus, the same control stream as native clients. |
| Hosting | The stack's **`web` profile**: a static client container + the gateway container, behind Traefik at `WEB_HOST` | Same box, same certs, same config file; self-hosters get it too. |

### Engine: size and startup

- `engine/cmd/wasm` (new): `ipc.ServeSession` over a `MessagePort`
  transport instead of a WebSocket or Wails events: the protocol the
  renderer already speaks.
- Size (measured, `-trimpath -ldflags=-s -w`): **11.6 MB raw, 2.2 MB
  brotli, 3.0 MB gzip**. Served with a content hash in its name and
  `Cache-Control: immutable`, so it is downloaded once per release.
- Startup: `WebAssembly.instantiateStreaming` compiles while it downloads;
  on a desktop machine compile + start is ~150–300 ms on a warm cache. The
  page renders immediately (the renderer doesn't wait for the engine to
  draw the directory); the engine socket opens when the worker is ready.
- In a Worker: IRC bursts, parsing and backlog replay stay off the UI
  thread. One engine per tab. A second tab of the same browser profile runs
  its own engine; v1 accepts that (the second tab's nick collides and gets
  the alternate nick); a single-tab lock or a SharedWorker is a later step.

### Dialing

`irc.dial` is the one place the engine opens a connection. It becomes a
build-tagged seam: native builds keep `net.Dialer` + `crypto/tls`; the wasm
build returns a `net.Conn` over a browser WebSocket to the gateway:

```
renderer ──postMessage──► Worker: engine.wasm ──wss://WEB_HOST/webirc/websocket/──► webircgateway ──TCP/TLS──► irc.example.net:6697
```

- After the socket opens the engine sends `HOST irc.example.net:+6697`
  (webircgateway's gateway mode; `+` = TLS upstream), then registers as
  usual (PASS/CAP/SASL/NICK/USER). One WebSocket text message per IRC line.
- **TLS is the gateway's**, not end-to-end: the browser has TLS to the
  gateway (wss), the gateway has TLS to the network. That is how every web
  IRC client works (KiwiIRC, The Lounge, gamja through a gateway). The
  gateway is operator-run infrastructure, logs no message content, and
  **verifies upstream certificates** (upstream webircgateway skips
  verification; our patch turns it on). "Accept self-signed certificate"
  on a server is passed as `HOST host:+port insecure` and is the only way
  to skip it.
- The gateway URL comes from the build (`VITE_WEB_GATEWAY_URL`, default
  same origin `/webirc/websocket/`).

## Architecture

```
chat.boson.chat (page)                                     boson VPS (stack, profile web)
┌───────────────────────────────────────────┐             ┌────────────────────────────────┐
│ renderer (client/, Preact) — unchanged UI │             │ Traefik ─► web (static, nginx) │
│ platform/web.ts installs window.boson*    │             │        ─► /webirc ─► gateway ──┼─► any IRC network (WEBIRC where trusted)
│   bosonEngine ─MessagePort─► Worker(wasm) ┼─ wss ──────►│                     └──────────┼─► ergo:6667 (WEBIRC trusted)
│   bosonVoice  ─ WebTransport datagrams ───┼─ h3 ───────►│ quicvoiced :7700/udp /wt       │
│   bosonVideo  ─ WebTransport streams ─────┼─ h3 ───────►│ quicvideod :7710/udp /wt       │
│   fetch (CORS) ───────────────────────────┼─ https ────►│ auth, api, directory, files    │
└───────────────────────────────────────────┘             └────────────────────────────────┘
```

### The seam: `window.boson*` bridges

The renderer reaches native features only through `window.boson*` bridges,
installed by `platform/wails.ts` in the desktop/phone shell, and already has
a browser fallback for each one that's absent. The web build adds
`platform/web.ts`, chosen at startup by `<meta name="boson-shell"
content="web">` in the web build's `index.html` (as `is-wails.ts` checks
`wails`). Each bridge, desktop vs web:

| Bridge | Desktop / phones (Go) | Web |
|---|---|---|
| `bosonEngine` | in-process engine over Wails events | engine.wasm in a Worker over a `MessagePort` (same JSON frames) |
| `bosonApi` | Go proxy (the wails:// origin has no CORS) | none: the existing direct-`fetch` fallback; CORS on api/auth/directory/files allows `WEB_HOST` |
| `bosonSecure` | file + OS keychain key | IndexedDB holding values encrypted with a **non-extractable** WebCrypto AES-GCM key (also in IndexedDB). Protects at-rest copies; script on the origin can still use the key, hence the CSP below. |
| `bosonThemes` | themes folder + watcher | localStorage-backed list/write/remove; no "open folder" (import a file instead) |
| `bosonUnfurl`, `bosonSpotify` | Go fetchers with an SSRF guard | **unavailable**: link previews and Spotify cards aren't shown (a page can't fetch other sites; a server-side fetcher is a later step). YouTube embeds work directly (the page is https). |
| `bosonImages` | on-disk image cache | none: the browser HTTP cache |
| `bosonBranding` | Go fetch + blob: images | direct `fetch` of the network's theme (auth `/v1/branding` sends CORS) |
| `bosonNetAuth` | boson.json + QUIC probe | `fetch https://<domain>/.well-known/boson.json` (needs `Access-Control-Allow-Origin: *` on the website), then `auth.<domain>/v1/config` |
| `bosonFiles` | uploads streamed by Go | direct `fetch` uploads to the files host (CORS `*`, bearer token), progress via upload streams/XHR |
| `bosonSSO` | loopback listener (RFC 8252) | a popup to the provider with `return_to = https://WEB_HOST/sso/callback?s=…`; the callback page hands the code back over `BroadcastChannel`; the PKCE exchange is unchanged. The auth service's `SSO_RETURN_TO_ALLOWED` gains `https://WEB_HOST/sso/callback`. |
| `bosonVoice` | Go VoiceService (QUIC, libopus, native audio) | TypeScript VoiceService: WebTransport, `getUserMedia` + AudioWorklet, Opus via WebCodecs, jitter buffer + mixer ported from `quicvoice/client/voice`; lip-sync AudioClock reports as on desktop |
| `bosonVideo` | Go VideoService (native capture/encode) | TypeScript VideoService on quicvideo's web client (WebCodecs H.264): camera via `getUserMedia`, screen via `getDisplayMedia` (the browser's own picker replaces ours; the "You're sharing" bar stays). Frames reach the existing `video.controller.ts` through the same frame-message format, over an in-page socket instead of the loopback WebSocket. |
| Notifications | native (`NotifyService`) | the Web Notification API (desktop browsers), plus in-app toasts as today |
| `bosonDeepLink` | `boson://` from the OS | `https://WEB_HOST/?join=<boson://join?…>` (and `/join?host=…`) read once on load |
| `bosonWindow` | custom title bar on Windows/Linux | none (the browser's own chrome) |
| `bosonUpdater` | in-app updates | none (each deploy is the latest) |
| `bosonYouTube` | wrapper origin | none needed |
| `bosonE2E` | e2e hooks (desktop/e2e.go) | an e2e build's in-page hooks for what the web can do (opened links, the API outage switch through a test proxy); the rest skip |

### Calls over WebTransport

- **quicvoice** gets an HTTP/3 + WebTransport listener on its QUIC port
  (ALPN `h3` next to `quicvoice/1`, path `/wt`), reusing quicvideo's
  vendored, patched `webtransport-go`. A session carries the same
  bidirectional control stream (varint-framed protobuf) and the same audio
  datagrams as native QUIC. `WEBTRANSPORT_ORIGINS` narrows which pages may
  open sessions; the token in `Hello` is still what authorizes. The public
  HTTP API (`/v1/rooms`) gains CORS for those origins.
- **Browser tokens**: the same voice tokens the desktop gets from the auth
  service (`POST /v1/voice/token`, guests `/v1/voice/guest-token`), fetched
  with the page's session. quicvideo tickets come from quicvoiced over the
  control stream as today.
- **Audio**: capture 48 kHz mono in an AudioWorklet (echo cancellation,
  noise suppression and AGC from `getUserMedia` — the browser gives us AEC,
  which the desktop lacks), 20 ms frames → `AudioEncoder` (Opus, the
  channel's bitrate cap) → uplink datagrams. Downlink datagrams → one
  `AudioDecoder` per speaker → jitter buffer → mixer worklet → the chosen
  output (`setSinkId` where supported). VAD/PTT, mute/deafen, per-user
  volume, mic test and levels mirror the desktop's state shape.
- **Browsers without WebTransport or Opus WebCodecs** (Linux WebKit,
  older Safari): chat works, the call buttons say "Calls need a browser with
  WebTransport (Chrome, Edge or Firefox)" (`audio: false` + `audioError`).

### Auth, tokens and CORS

- Session and refresh tokens live where the renderer already keeps them,
  through `bosonSecure` (encrypted IndexedDB above). No cookies; every call
  is `Authorization: Bearer`, so CORS needs no credentials mode.
- CORS allow-lists gain `https://WEB_HOST`: auth (`CORS_ALLOWED_ORIGINS`),
  api (`ALLOWED_ORIGINS`), directory (public GETs are `*`; owner calls need
  the origin), files (`*` already), quicvoice (new, this work), quicvideo
  WebTransport (`WEBTRANSPORT_ORIGINS`). The stack derives them from
  `WEB_HOST`.
- **CSP** (served by the web container): `default-src 'self'`; scripts only
  `'self'` + `'wasm-unsafe-eval'`; `connect-src 'self'` + the stack's
  https/wss/WebTransport hosts; `frame-src` YouTube; no inline script. With
  tokens and the identity key in the origin, XSS is the risk that matters:
  no third-party scripts, DOMPurify for rendered markdown (as today).

## Unavailable or different on the web

| Feature | Web |
|---|---|
| Link previews, Spotify cards | not shown (no server-side fetcher yet) |
| Image disk cache, its settings | browser cache; the Settings row is hidden |
| Theme folder ("Open folder", live file watch) | stored in the browser; import/export instead |
| Native screen-share picker (thumbnails, window list) | the browser's picker |
| Screen-share sound | not yet (sending or playing) |
| OS notifications when the tab is closed | none (Web Notifications only while the tab is open) |
| Custom title bar, updater | none |
| `boson://` links | `https://WEB_HOST/?join=…` |
| Background running | closing the tab disconnects (bouncer users keep presence) |
| Calls without WebTransport (Linux WebKit) | chat only, with the message above |

## The gateway and its security

webircgateway (kiwiirc) built from a pinned commit with our patches and a
policy file compiled in (`stack/images/webircgateway/`). Without guards a
WebSocket→TCP gateway is an open proxy; the guards:

- **Ports**: IRC ports only: 6660–6669, 6697, 7000, 7070, 9999, plus
  `WEBIRC_EXTRA_PORTS`. Anything else is refused before dialing.
- **Addresses**: the destination is resolved and checked at connect time
  (a `net.Dialer.Control` hook, so DNS rebinding can't slip past):
  loopback, private, link-local, CGNAT, multicast and reserved ranges are
  refused, except named internal aliases (`irc.boson.chat` → `ergo:6667`)
  the operator configures.
- **Allow/deny lists**: `WEBIRC_UPSTREAM_ALLOW` (empty = any public
  network) and `WEBIRC_UPSTREAM_DENY` (globs), checked on the hostname.
- **Per-IP limits**: concurrent connections per client IP (default 5),
  new connections per IP per minute (default 10), lines per second from the
  client (webircgateway's throttle, default 2/s sustained with a burst).
  The real IP is read from `X-Forwarded-For` only from Traefik.
- **Origins**: only `https://WEB_HOST` pages may open the WebSocket.
- **WEBIRC**: sent with the user's real IP to networks that list the
  gateway (`[gateway.webirc]` passwords); Boson's own Ergo trusts it from
  the gateway's compose address with `WEBIRC_PASSWORD`. Other networks see
  the VPS IP; they may cap connections from it.
- **Upstream TLS verified** (patch) unless the user marked the server
  self-signed.
- **Logs**: host, port, client IP, time, close reason; never line content.

## E2E plan

The real-app suite (`client/tests/e2e-app`, ~110 specs) and the call-layout
specs run against the web build too, through the **launcher**, not copies:

- `launchApp()` (fixtures.ts) picks the target from `E2E_TARGET`:
  `desktop` (today: the server-mode binary) or `web` (the static web build
  served by a tiny Node server on a fixed port, opened in a persistent
  context of `E2E_BROWSER` = chromium | firefox | webkit). The e2e stack
  gains a webircgateway container (same image as production, e2e policy:
  loopback/compose aliases allowed) and CORS for the web origin.
- Specs that can't apply on the web are tagged once (`webSkip(reason)`;
  `webBrowserFixme` marks known gaps in one browser) — only
  native-only behaviour: the native screen picker, OS notifications /
  focus restore, second-instance argv, the on-disk image cache, the theme
  folder watcher, link-preview/Spotify fetchers, the updater. The list is
  in the README next to the specs.
- Playwright projects: `web-chromium`, `web-firefox`, `web-webkit`. Calls
  are checked where WebTransport exists (Chromium, Firefox; WebKit only
  where it has it) against a local quicvoiced/quicvideod with a 13-day
  ECDSA dev cert (`serverCertificateHashes`).
- CI: a `web` job in `e2e.yml` (matrix over the three browsers) next to the
  unchanged desktop job.

## Releases and deploy

- boson: `harbor.floret.dev/boson/web` image (static build + nginx with the
  CSP and caching headers), built by the release workflow.
- quicvoice: a minor release with WebTransport + CORS.
- stack: `web` profile (`web`, `webircgateway`), `WEB_HOST`, Ergo WEBIRC
  trust, CORS and SSO return_to derived from `WEB_HOST`, docs, CI smoke.
- Deploy (main session): DNS `chat.boson.chat` → the VPS, `.env`
  `WEB_HOST`, `COMPOSE_PROFILES` + `web`, `CERT_HOSTS` + `chat.boson.chat`,
  `WEBIRC_PASSWORD`, new image pins.
