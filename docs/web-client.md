# Boson in the browser: the engine as WebAssembly, the app at boson.chat/chat

Status: **plan for review**. No code until it's agreed.
Starting point: main at 0.39.1 — the Wails desktop app (`desktop/`), the
renderer (`client/`), the Go engine (`engine/`), the marketing site
(`website/`, a Cloudflare Worker with static assets on boson.chat).

## Goal

The same app as the desktop client, running in a browser at
**https://boson.chat/chat**, for accounts and guests. The engine — the Go
IRC logic — runs inside the page as WebAssembly, as it runs in-process in
the desktop app. For development: the website's dev server, with the chat
app, pointed at the local Supabase and backend.

## The constraint that shapes everything

A browser page (JavaScript or WebAssembly alike) can't open a TCP
connection. Its network APIs are `fetch`, WebSocket, WebRTC and
WebTransport; IRC servers listen on plain TCP (6667, 6697, …). Chrome's
Direct Sockets API is limited to installed Isolated Web Apps, not websites.
So the engine runs in the page, but its IRC connections need something
WebSocket-shaped at the other end:

1. **Direct IRC-over-WebSocket**, for servers and bouncers that offer it:
   Ergo (our default local server; `websockets` listener), soju, and the
   UnrealIRCd/InspIRCd networks that enable their websocket module. Nothing
   in between; costs nothing.
2. **A relay on the boson.chat Cloudflare Worker** for every other server:
   WebSocket in, TCP out (Workers' `connect()` sockets API). No server of
   ours to run — it's the Worker that already serves the website.

**TLS stays end-to-end.** The engine does the TLS handshake itself (Go's
`crypto/tls` works in WebAssembly) over the relayed byte stream, so for
TLS servers the relay only ever forwards ciphertext; it can't read or alter
IRC traffic. Plain-text servers are as exposed as they are on the desktop.

Decided (2026-10-16): relay on the Cloudflare Worker + direct WebSocket;
accounts and guests.

### What the relay costs

Workers Free allows 10 ms of CPU per request; a WebSocket is one request that
lives as long as the IRC session, so the relay needs **Workers Paid: $5/month
minimum**, which includes 10M requests and 30M CPU-ms a month (then
$0.02/million CPU-ms). WebSocket messages aren't billed as requests and
time spent waiting on the network isn't CPU time. Forwarding bytes is cheap:
roughly 1,000 users chatting 8 h/day at ~1 IRC line/s ≈ 40M CPU-ms/month ≈
$5.20 total (an estimate). Open: how outbound `connect()` sockets are priced
(not in the pricing docs), and the 5-minute CPU cap per invocation — a very
long, very busy session could reach it and reconnect (the engine already
reconnects). Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### The relay's IP is everyone's IP

Through the relay, every web user connects from Cloudflare's egress
addresses. Networks limit connections per IP and ban abusive ranges, so:

- **Per-IP limits** on big networks (Libera, OFTC, …) may cap how many web
  users can be on at once. WEBIRC (passing the real user IP to the network)
  needs a fixed gateway IP and an agreement with each network — Cloudflare's
  egress IPs aren't fixed, so WEBIRC isn't available through the Worker.
- **One abuser can get the range banned** for everyone on that network.

Mitigations: the relay's own limits (below), direct WebSocket wherever a
network offers it, and bouncer users connecting to their bouncer (one
connection, from the bouncer's IP, to the network). If a big network objects,
the fallback is a small relay with a fixed IP and WEBIRC agreements — the
thing this plan avoids hosting; noted as the escape hatch, not planned.

## Architecture in the browser

```
boson.chat/chat (page)                       Cloudflare Worker (boson.chat)
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ renderer (client/, Preact)   │             │ static assets (website + app)│
│   window.boson* web bridges  │             │ /irc  WebSocket ↔ TCP relay  │
│        ▲ MessagePort         │             │ /unfurl, /spotify  fetchers  │
│ SharedWorker                 │  WebSocket  └──────────────┬───────────────┘
│   engine.wasm (Go)  ─────────┼─────────────►  relay ───────┼──► IRC server :6697
│     dial: direct WS or relay ┼─────────────────────────────┼──► IRC server (WS)
└──────────────────────────────┘                             │
         │ fetch (CORS)                                      │
         └──────────────────────────► api.boson.chat (backend), Supabase
```

### The engine: WebAssembly in a SharedWorker

- `GOOS=js GOARCH=wasm` build of a new `engine/cmd/wasm` main. The engine
  already compiles for it unchanged (checked). Size: **11 MB raw, 2.1 MB
  brotli** (2.9 MB gzip) — Cloudflare serves brotli; it's fetched once and
  cached. TinyGo would be smaller but doesn't support everything girc and
  the engine use; not worth it up front.
- It runs in a **SharedWorker**, one per browser profile, not in the page:
  - off the UI thread (IRC bursts, parsing, history);
  - **one engine for all tabs** — two tabs must not open two IRC
    connections with the same nick. Each tab talks to the shared engine over
    a `MessagePort`. Safari supports SharedWorker since 16; where it's
    missing, fall back to a dedicated Worker plus a single-tab lock (Web
    Locks API) that tells a second tab the app is open elsewhere.
- The protocol is the existing one: `ipc.ServeSession` over a `Transport`
  (the transport split from the Wails work), here backed by `MessagePort`s instead of a WebSocket or
  Wails events. The renderer keeps using its `WebSocketLike` engine socket
  (`platform/web.ts` provides one over the port, as `platform/wails.ts` does
  over Wails events).
- **Multiple sessions on one engine:** today one session owns its IRC
  connections and quits them when it closes. With several tabs on one
  SharedWorker the engine needs connections that outlive a tab: owned by the
  worker, attached to by sessions (each tab subscribes to events and can
  send commands), quitting only when the last tab goes away. This is the one
  real engine change; it's also what a future "app keeps running in the
  background" mode on desktop would want.

### Dialing: `engine/irc` gets a pluggable dialer

`irc.dial` is the one place the engine opens a connection (TCP + optional
TLS + a line filter). It becomes `Config.Dial` (default: today's `net.Dialer`
code), and the wasm build plugs in a browser dialer that returns a `net.Conn`
over a JS WebSocket:

- **Direct**, when the server is known to speak IRC-over-WebSocket:
  `wss://host:port/…` with the IRC text subprotocol. Messages are lines, so
  that `net.Conn` frames lines rather than bytes, and TLS is the browser's
  (wss). Known how: a per-server flag/URL — in the directory entry for
  listed servers (new column), and an "IRC over WebSocket" option when adding
  a server by hand. No probing of random ports.
- **Relayed**, for everything else: `wss://boson.chat/irc?host=…&port=…`
  carrying raw bytes (binary frames); the engine's TLS runs over it as it
  does over TCP.

The desktop app keeps dialing TCP directly; nothing changes there.

### The relay (on the existing Worker)

`website/` gains a Worker script (`main` in `wrangler.toml`, assets still
served as today, `run_worker_first` only for `/irc*`, `/unfurl`, `/spotify`):

- `GET /irc?host&port` with `Upgrade: websocket` → `connect({hostname, port})`
  → pipe both directions (streams, so the Worker barely touches the bytes).
- **Guards** (this is an open TCP proxy otherwise):
  - **Who:** a short-lived relay token. Signed-in users get one from the
    backend (`POST /relay-token`, signed with a secret the Worker shares,
    ~5 min, single host:port); guests get one after a **Turnstile** check
    (free, invisible for most people). No token, no relay.
  - **Where:** IRC ports only (6660–6669, 6697, 7000, 7070, 9999 and the
    ports of directory-listed servers); hostnames only (no IP literals);
    never private, loopback, link-local or reserved ranges after resolution
    (Workers can't reach Cloudflare's own addresses or port 25 anyway).
  - **How much:** connections per user / per guest / per client IP
    (Workers Rate Limiting binding), a byte budget per connection, an idle
    timeout, and an abuse report path (logs keep host, port, user id, time;
    never content).
- The 5-minute CPU cap per invocation: the relay closes cleanly near it and
  the engine reconnects; with streaming pipes it's unlikely to be reached.

### The native services, web versions

The renderer reaches native features through `window.boson*` bridges. The
web build installs `platform/web.ts` (as the desktop app installs
`platform/wails.ts`), chosen at startup the same way (`is-wails.ts` → a small
`platform/detect.ts`). Most already have browser fallbacks:

| Bridge | Desktop (Go) | Web |
|---|---|---|
| `bosonEngine` | in-process engine over Wails events | engine.wasm in a SharedWorker over MessagePort |
| `bosonApi` | Go proxy (CORS) | direct `fetch` (existing fallback); backend CORS gains `https://boson.chat` (already there) and the dev origin |
| `bosonSecure` | file + OS keychain key | IndexedDB + a non-extractable WebCrypto AES-GCM key (same `fb1:`-style envelope idea; new `wb1:` tag). Without it the renderer turns identity persistence off (today's memory fallback). |
| `bosonUnfurl`, `bosonSpotify` | Go fetchers with SSRF guard | the Worker's `/unfurl` and `/spotify` (same rules; Workers can't reach private networks); rate-limited per IP |
| `bosonThemes` | themes folder + watcher | already falls back to browser storage (no folder) |
| `bosonYouTube` | wrapper from boson.chat | none needed: the page *is* boson.chat, so YouTube embeds directly |
| notifications | native | Web Notification API (asks permission on first mention, not on load) |
| `bosonDeepLink` | `boson://` from the OS | `boson.chat/chat?join=…` links; `/auth/confirmed` redirects into `/chat` instead of `boson://` |
| `bosonWindow`, title bar | native window | no custom title bar; the browser's |
| `bosonUpdater` | release check | none (the web app is always the latest deploy) |
| `bosonE2E` | e2e hooks | e2e build only (see Tests) |

Security for the page: a strict CSP (no inline script; `connect-src` for the
API, Supabase, `wss://boson.chat`, and `wss:` for direct IRC-over-WebSocket),
since the secure store and session tokens live in the page's origin now.

### Mounting the app at /chat

- The renderer builds a second time with `base: '/chat/'` into
  `website/dist/chat/` (one `npm run build` for the site does both). The
  marketing site's Vite build stays as is.
- The Worker routes `/chat` and `/chat/*` to `/chat/index.html` (the app's
  own client-side state; it has no URL routes today), everything else as now
  (the site's SPA fallback).
- Website nav gets "Open in browser" next to Download.

### Dev setup

- `make web-dev`: like `make client-env` it reads the local Supabase URL and
  anon key (`supabase status`) and starts the **website dev server**
  (`:5174`) with the chat app at `/chat`, using the Cloudflare Vite plugin
  so the Worker's routes (`/irc` relay, `/unfurl`) run locally in workerd
  with hot reload. The relay in dev needs no token (dev builds only).
- Local backend on `:3000` (`make run`) with `ALLOWED_ORIGINS` including
  `http://localhost:5174`; local Supabase's auth redirect URLs gain
  `http://localhost:5174/chat`.
- The local ergo (`make ergo-up`) gets its `websockets` listener enabled, so
  dev exercises the direct path; any other server goes through the local
  relay.
- The engine: `make web-engine` builds `engine.wasm` (and copies Go's
  `wasm_exec.js`) into the app's public dir; `web-dev` rebuilds it on
  `engine/` changes.

## Phases

### Phase 0: spikes (go/no-go, ~3 days)
1. engine.wasm in a SharedWorker, connecting to the local ergo over its
   WebSocket listener, joining a channel, from a bare test page.
2. The same through a Worker relay (`wrangler dev`) to a TLS server, TLS in
   the engine. Measure CPU per relayed MB.
3. One relay connection to a big network (Libera) and a check of its policy
   on connections from Cloudflare ranges.
4. Load time on a cold cache with the 2.1 MB engine; startup to "connected".

### Phase 1: engine (~1 week)
- `Config.Dial` and the browser dialers (direct, relayed); line-framed conn
  for direct WebSocket.
- Sessions attach to worker-owned connections (several tabs, one engine).
- `engine/cmd/wasm`: the JS glue (MessagePort transport, start/stop).
- Go tests for the dialer seam and multi-session ownership; the existing
  engine tests keep running natively.

### Phase 2: relay + Worker routes (~1 week)
- Worker script with assets + `/irc`, `/unfurl`, `/spotify`; guards, rate
  limits, logging; Turnstile for guests; backend `POST /relay-token` and the
  shared secret.
- Directory: an "IRC over WebSocket" URL per server; manual add option.
- Tests: Worker unit tests (Vitest + workerd pool) for every guard.

### Phase 3: the web shell (~1–2 weeks)
- `platform/web.ts`: engine over MessagePort, secure store (IndexedDB +
  WebCrypto), unfurl/Spotify via the Worker, notifications, deep links via
  URL, no title bar/updater.
- The `/chat` build and routing; auth redirects; website nav link.
- `make web-dev`, ergo websockets in dev.

### Phase 4: tests and CI (~1 week)
- The real-app e2e suite gets a second target: the web build in Chromium,
  Firefox and WebKit (Playwright drives all three here — browsers are its
  home turf), against the e2e stack with ergo's WebSocket listener and a
  local relay. Specs that are desktop-only (window, native notifications)
  skip there.
- CI: the web e2e job alongside the desktop one; the website deploy builds
  the engine and the app.

### Phase 5: rollout
- Ship to boson.chat/chat behind a "beta" label; watch relay CPU, errors
  and per-network rejections; then link it from the homepage.

Rough size: 5–6 weeks. The largest parts are the multi-tab engine sessions
and the relay's guards, not the WebAssembly build itself.

## Risks

- **Network policy on shared IPs** (above) — the biggest unknown; Phase 0
  checks it before anything else is built.
- **Background tabs.** Browsers throttle timers in background tabs; the
  engine in a (Shared)Worker is less affected, but closing the last tab
  ends the IRC session (QUIT) — unlike the desktop app, which keeps running.
  Bouncer users keep their presence through the bouncer.
- **Storage eviction.** IndexedDB can be evicted under storage pressure;
  request persistent storage (`navigator.storage.persist()`) and keep the
  account's encrypted identity recoverable from the backend, as today.
- **Secrets in a web origin.** XSS on boson.chat would reach the secure
  store; the strict CSP, no third-party scripts on `/chat`, and the
  non-extractable key (it can be used by injected script but not exported)
  are the mitigations.
- **Workers platform limits** (CPU per invocation, connect() pricing) —
  checked in Phase 0.

## Open questions for review

1. **Relay costs:** fine to move the account to Workers Paid ($5/month+)?
2. **Guests and the relay:** Turnstile for guests, plus lower caps — or
   guests on direct-WebSocket servers only?
3. **Which IRC ports** the relay allows beyond the common ones.
4. **Closing the last tab quits IRC.** Acceptable for v1, or should the web
   app push people towards a bouncer (or a hosted one) from the start?
