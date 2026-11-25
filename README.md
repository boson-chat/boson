# Boson

A desktop chat app that feels like Discord, built on real IRC. See [PRD.md](./PRD.md) for the product vision.

## Architecture

The client repo:

```
desktop/            The desktop app (Wails v3, Go): native window, the engine in-process, OS services
client/             Preact renderer (the UI the desktop app shows)
engine/             Go IRC engine — run inside the desktop app; `engine serve` bridges it over a WebSocket for browser dev
packages/shared/    @boson/shared — design system (Button, Card, …)
infra/              Local and e2e stacks (ergo, ZNC, services packages), compose files
```

Elsewhere:

- The HTTP API (verifies auth-service tokens, user identity/sessions, nick claims, presence) is [boson-chat/backend](https://github.com/boson-chat/backend), released as the image `harbor.floret.dev/boson/backend`.
- The public marketing site (boson.chat) is [boson-chat/website](https://github.com/boson-chat/website).

The public server directory is its own service, [boson-chat/directory](https://github.com/boson-chat/directory) (https://directory.boson.chat), which also answers the legacy `api.boson.chat/servers` routes; the backend no longer serves `/servers`.

Accounts and sign-in are the boson auth service ([boson-chat/auth](https://github.com/boson-chat/auth)); the move off Supabase Auth is described in [docs/migration-supabase-to-auth.md](./docs/migration-supabase-to-auth.md).

## Run it locally

### Prerequisites

- **Go** ≥ 1.27
- **Node** ≥ 22.12 + npm
- For the desktop app: a cgo toolchain — macOS: Xcode; Linux: GTK 4 + WebKitGTK 6.0 dev packages (`libgtk-4-dev libwebkitgtk-6.0-dev`); Windows: MSYS2's MinGW-w64 gcc (WebView2 ships with Windows 10/11)
- For voice in the desktop app: `pkg-config` and libopus for dev builds (macOS: `brew install opus pkgconf`; Debian/Ubuntu: `libopus-dev pkg-config`), `cmake` for release builds (they build a static libopus: `desktop/scripts/build-opus.sh`). The voice SDK is the public Go module `github.com/boson-chat/quicvoice`.
- **Docker** + `docker compose` (the auth service + ergo IRCd + Mailpit + MinIO run in containers)
- **The auth service** — a checkout of [boson-chat/auth](https://github.com/boson-chat/auth) next to this one (`gh repo clone boson-chat/auth ../auth`, or set `AUTH_SRC`). Accounts, sign-in and tokens live there; `make auth-up` builds and runs it.
- **The backend** (for signed-in features) — [boson-chat/backend](https://github.com/boson-chat/backend), run from its checkout (see its README) on `http://localhost:3000`.

### First-time setup

```bash
make dev-up
```

That single command spins up everything needed:

- The boson auth service on `http://localhost:8080` (`make auth-up`); its mail (verification, password reset) lands in the Mailpit at `http://localhost:8026`
- Local ergo IRCd on `:6667` (under the `testing` profile, so it doesn't run in production stacks)
- Mailpit (`:1025` SMTP, `:1110` POP3, UI `http://localhost:8025`) and MinIO (`:9000`), which the backend's nick claims and avatars use in dev

`make dev-up` is idempotent; rerun it after a reboot.

### Day-to-day: four shells

After `make dev-up`, run these in **four separate terminals**:

```bash
# 1. Boson HTTP API (identity, user sessions, nick claims, presence), from a
#    boson-chat/backend checkout — see its README

# 2. Local IRC engine (WebSocket bridge between the renderer and IRC)
make engine-serve

# 3. The renderer in a browser on http://localhost:5173 (hot reload)
make client-dev

# 4. (Optional) Fake user that types into a channel — useful for verifying
#    the IRCv3 typing indicator + unread badges without a second human.
make typingbot
```

The page reads the engine's discovery file (`~/.boson/engine.json`, or `$XDG_RUNTIME_DIR/boson/engine.json`) on every load, so a restarted engine is picked up by a reload.

For the real desktop app (native window, secure store, link previews, notifications…), run `make desktop-dev` instead of 2 and 3: a dev build of `desktop/` with the renderer built against your `client/.env`, the engine in-process. `make desktop-build` makes a release build for your machine in `desktop/bin/` (macOS: a signed `.app` + DMG for Apple Silicon and for Intel; set `NOTARY_PROFILE` to notarize, `ARCHS=arm64` for one). Against production: `VITE_BOSON_API_URL=https://api.boson.chat VITE_AUTH_URL=https://auth.boson.chat make desktop-build`.

### Voice channels

Voice is per IRC server, desktop only (macOS, Windows, Linux; not iOS/Android). The app looks for `https://<domain>/.well-known/boson.json` (`<domain>` = the IRC host minus its first label), falling back to a QUIC probe of `voice.<domain>:7700`, and offers voice only when that server's auth service is the one you're signed in to and its voice server is under that auth service's domain. Audio and the QUIC connection are Go (`desktop/voice*.go`, the quicvoice SDK); the renderer draws the VOICE section, the connected bar and Settings → Voice (`client/src/renderer/src/modules/voice`). To try a local quicvoiced, point an IRC host at it in a dev build: `BOSON_VOICE_JSON=/path/to/boson.json make desktop-dev`, where the file's `irc.host` is the server you're connected to and `voice.addr` / `voice.url` are the local server's (`AUTH_INSECURE=true` on quicvoiced accepts any token). No echo cancellation yet: use headphones.

Voice channels can be managed from the app on quicvoice 1.5+ servers (`GET/POST/PATCH/DELETE /v1/rooms`): they show under their IRC channel in the channel list (the rest, and those of channels you're not in, under VOICE). The `+` on a channel row or the VOICE header makes one where the server lets you (`permissions.create_scope`); right-click one you manage (or its gear) to rename, move, lock (who can join, who can talk, must be in the channel) or delete it. Locked rooms show a lock; rooms where you can't talk join as a listener. To try it locally, run quicvoiced with `AUTH_INSECURE=true VOICE_CHANNEL_CREATION=registered` (the token is then just a user name).

Every voice channel is also a video channel where the voice server has video (quicvoice 1.8+ with quicvideod; voice.boson.chat does). On joining, the app asks the voice server for a video ticket; a server without video says no and nothing video shows. With one, `desktop/video.go` (`VideoService`) connects to the server's quicvideod, follows the channel's video room, and:
- hands received video to the renderer over a loopback WebSocket (`ws://127.0.0.1:<random port>/video?k=<per-launch secret>`) as AVC (avcC + length-prefixed NAL units) for WebCodecs, which every webview decodes (WebKitGTK only in this form);
- sends the camera and screen with quicvideo's native capture and hardware encoders on macOS (screen sharing from macOS 12.3) and Windows. Linux release builds watch but don't send yet: native capture there needs FFmpeg, openh264 and PipeWire, so it's behind `-tags videocapture` until the packages carry them;
- keeps each person's video in sync with their audio: senders report how their audio clock maps to wall time (quicvoice `AudioClock`), the engine reports which of their audio is playing (`Engine.Playout`), and the renderer shows each frame at capture time + that person's offset (kept through their silences). When someone's video arrives later than their audio would play, their audio is delayed a little (up to 150 ms, while their video is on screen), so sound never runs more than ~45 ms ahead of the picture (ITU-R BT.1359). `desktop/cmd/avmeasure` measures it end to end against local servers.

### Sign in with an identity provider

When the auth service has SSO providers (`GET /v1/config` → `sso_providers`), the desktop app's login screen shows a "Continue with …" button for each. The app listens on a random `127.0.0.1` port (`desktop/sso.go`), opens the system browser at the provider's `start_url` with that as `return_to` and a PKCE challenge, and trades the one-time code that comes back for a session (`POST /v1/sso/exchange`). On a new device the identity key still needs its passphrase (the account's password, or one chosen at the first SSO sign-in). Settings → Account lists and unlinks linked sign-ins. `BOSON_SSO_E2E_AUTH=<auth url> go test -run SSOAgainst ./desktop/` runs the flow against a real auth service and Dex (see boson-chat/auth's `make test-dex-up`; the Dex client's redirect URI must be that auth's callback).

### Channel registration (ChanServ)

Channel settings has a Registration tab, and a shield next to the channel name shows whether the channel is registered and to whom. Signed-in channel operators can register an unregistered channel; its founder (and ops, as far as the services allow) can manage persistent roles, ChanServ protection options next to the +R/+M locks, transfer ownership and unregister (typed confirmation). The client works out which services package the network runs (the engine's NickServ/ChanServ probe, `004`, `NETWORK=`, ChanServ's reply shapes) and maps every action onto it (`client/src/renderer/src/modules/chanserv`): Ergo (AMODE, TRANSFER with the accept step, UNREGISTER code), Anope 2.x (XOP/ACCESS, SET FOUNDER, DROP), Atheme (FLAGS templates, +F handover, DROP key), Undernet X (status only), other ChanServs such as DALnet's (status only) and QuakeNet's Q (hidden). Replies it can't read (translated services, unknown forks) show as "Couldn't read ChanServ's reply", never as a guessed state. On the boson network the auth service's `GET /v1/config` adds `channel_auto_register` (the Register button is hidden; channels are registered for their creator) and `channel_expiry_days` (shown as "Expires after N days of inactivity").

`make test-e2e-chanserv` runs the adapters end to end against real Ergo, UnrealIRCd+Anope and InspIRCd+Atheme in docker (`infra/chanserv-e2e/`) and refreshes the captured transcripts (`engine/internal/services_e2e/fixtures/*/chanserv-*.json`) that the normal test run replays.

### Nick claims (automatic NickServ registration)

A signed-in user can have Boson register their nick on another IRC network: the api mints a plus-addressed email (`POST /me/nick-claims`), the client sends NickServ `REGISTER` with it, and the api hands the confirmation code back (`GET /me/nick-claims/{id}`) for `CONFIRM`. It is off by default per network; while it is off, `GET /config` says `{"nick_claim": false}` and the client hides the one-click claim and points to the manual NickServ form. Configuration (the `nick_claim:` section, the inbound mailbox, the internal admin endpoints) is documented in [boson-chat/backend](https://github.com/boson-chat/backend).

### Skip auth (guest mode)

On the login screen, click **"Continue without an account"** and pick a nick — you'll land directly in the directory. No backend `/me`, no encrypted identity, no sync. Useful for kicking the tyres.

### Add a server that isn't in the directory

In the directory, click **Advanced** in the filter row → **+ Add server manually**. Enter hostname/port/TLS/name. Local entries are stored in `localStorage` only — never published to the backend directory.

### Build the client

```bash
make client-build       # production bundle in client/out/
```

## Website (marketing site)

The public marketing site is its own repo, [boson-chat/website](https://github.com/boson-chat/website). Its download links point at this repo's release assets (see [Releases](#releases)).

## Run the tests

```bash
make test               # Go + TS unit tests
make test-go            # Just Go (the engine)
make test-client        # Just renderer (vitest)
make test-e2e           # Playwright E2E (needs the full dev stack + engine built)
make test-e2e-app       # Real desktop app E2E (needs only Docker — see below)
```

### End-to-end tests (real app)

`client/tests/e2e-app/` drives the **built desktop app** — `desktop/` as a
server-mode binary: the real Go services and in-process engine, serving the
renderer over HTTP — in Playwright's Chromium (Playwright can't drive the
native webviews; what needs the native window is checked by hand). Guest specs: manually added server → chat with a raw IRC
peer bot, restore-on-relaunch, the ZNC bouncer flow (auto-connect,
disconnect, reconnect), navigation-guard smoke tests. Account specs: sign-up
→ confirmation email → `boson://auth/confirmed` deep link → sign-in → handle
setup → a seeded directory server → chat → relaunch restores the session.
Fixtures and helpers for writing more: `client/tests/e2e-app/README.md`.

```bash
make test-e2e-app        # stack up + build app/engine + run the suite
make test-e2e-app-down   # stop the whole e2e stack and drop its state

# Iterating (stack already up):
cd client
npm run build:e2e-app    # → client/out-e2e + desktop/bin/boson-e2e-server; rerun after code changes
npm run test:e2e:app     # add e.g. `-- bouncer` to run one spec file
node scripts/e2e-stack.mjs status            # what's running where
node scripts/e2e-stack.mjs restart-backend   # recreate the backend container (re-runs migrations)
```

Needs docker, Go and an auth service checkout (`../auth`, or `AUTH_SRC=…`; or `AUTH_IMAGE=…` for a built image). The backend runs from its image, `harbor.floret.dev/boson/backend`, at the version pinned in `infra/e2e/docker-compose.yml` (`BACKEND_IMAGE=…` or `BACKEND_IMAGE_TAG=…` to try another, e.g. one built from a boson-chat/backend checkout). `make test-e2e-app-up`
(`client/scripts/e2e-stack.mjs up`, ~10s warm, idempotent) brings up the
isolated stack; endpoints are in `infra/e2e/stack.json`:

| Piece | Where | Notes |
| --- | --- | --- |
| ergo | `127.0.0.1:16667` | NickServ registration mails the catch-all Mailpit |
| ZNC 1.9 | `127.0.0.1:16501` | users `tester1`..`tester8` / `pw`, network `ergo`; leased one per test |
| Postgres | `127.0.0.1:16432` | the backend's DB (`boson`/`boson`), migrated on `up` (`backend-migrate`: the image's `migrate up`) |
| Network directory | `http://127.0.0.1:18480` | [boson-chat/directory](https://github.com/boson-chat/directory) image, fake DNS, no verify/health workers; its own Postgres on `:16434`. The e2e build's default directory |
| Mailpit (catch-all) | SMTP `:11025`, POP3 `:11110`, UI `http://127.0.0.1:18025` | boson.chat catch-all: ergo writes, the backend's nick-claim worker drains |
| MinIO | `http://127.0.0.1:19000` (console `:19001`) | R2 stand-in, bucket `boson` (public read) |
| Auth service | `http://127.0.0.1:18180` | boson auth service (own Postgres on `:16433`), email verification required; admin `e2eadmin` for the tests' lookups |
| Mailpit (auth) | `http://127.0.0.1:18325` | the users' inboxes: verification / password-reset mail |
| Backend | `http://127.0.0.1:13000` (internal listener `:13001`) | [boson-chat/backend](https://github.com/boson-chat/backend) image, env-only config in the compose file |

Isolation, so it can run next to a live dev stack:

- Compose project `boson-e2e` (own containers, network, ports) — the dev
  `boson-*` containers are never touched. Compose state is tmpfs.
- The backend runs in the same compose project with all config from env, so
  no local backend config (which may hold real mail credentials) is loaded.
- The renderer is built into `client/out-e2e/` (`E2E_OUT_DIR` to change;
  not `client/out/`) with the backend/auth URLs pinned to the e2e
  stack, so a local `client/.env` can't leak in.
  Guest specs pass without the stack's account half running.
- Every test launches the app with a throwaway `HOME`, `XDG_RUNTIME_DIR`,
  data dir and browser profile, with the secure store in its derived-key
  mode — your real app data and keychain are left alone. The e2e build
  records links instead of opening them, so nothing opens in your browser.
- Tests use random channels, nicks, emails and handles and lease their own
  ZNC user, so they run in parallel: 4 workers locally, 3 in CI
  (`E2E_WORKERS` overrides). Several people can share one stack with their
  own `E2E_OUT_DIR` / `E2E_RESULTS_DIR` / `E2E_COVERAGE_DIR`.

Failures leave a screenshot and the app's log (Go services, engine,
renderer console) in `client/test-results/e2e-app/`; the backend's log is
`docker compose -f infra/e2e/docker-compose.yml logs backend`. CI runs the same suite on Linux
(`.github/workflows/e2e.yml`).

#### Coverage

```bash
make test-e2e-app-coverage   # stack + coverage build + run → client/coverage/e2e/

# Iterating (stack already up):
cd client
E2E_COVERAGE=1 npm run build:e2e-app
npm run test:e2e:app:coverage
```

`E2E_COVERAGE=1` builds the renderer with source maps (unminified) and the
app with `go build -cover`, then measures two layers across every launch in
the run (relaunches included). The backend's coverage is collected in its own
repo.

- **Renderer** — Playwright's JS coverage, started before the page loads and
  taken just before the app closes (`tests/e2e-app/desktop-app.ts`).
- **App + engine** — `GOCOVERDIR` for the desktop app's binary (`desktop/`
  and the `engine/` packages it links in); counters are written when it
  exits on SIGTERM.

Reports are mapped back to `client/src/…`, `desktop/…` and `engine/…`
(node_modules, tests and the shared workspace package are excluded):
`renderer/` and `engine/` each hold an `index.html`
and `lcov.info`, and `summary.md` has per-layer totals plus the
least-covered files. CI runs with coverage on, adds `summary.md` to the job
summary and uploads the reports as the `e2e-app-coverage` artifact. A
coverage build left in `client/out-e2e` still works for a plain
`npm run test:e2e:app`; rebuild without the flag for representative timings.

## Releases

Every release tag (cut by semantic-release on `main`) builds the desktop app
on macOS, Windows and Linux (`.github/workflows/desktop.yml`) and attaches it
to the GitHub Release: `Boson-mac-arm64.dmg` and `Boson-mac-x64.dmg`
(Apple Silicon and Intel; Developer ID signed, notarized), `Boson-windows-x64.zip`, `Boson-linux-x86_64.tar.gz` and
`SHA256SUMS.txt`. It also attaches what the in-app updater reads: `Boson-mac-arm64.app.zip` and `Boson-mac-x64.app.zip`, plus
`update-manifest.json` and its ed25519 signature `update-manifest.json.sig`, signed with the `UPDATE_SIGNING_KEY` secret
([docs/wails-migration.md](docs/wails-migration.md), "Phase 5: updater"). The website's ([boson-chat/website](https://github.com/boson-chat/website)) download links point at those names. When the iOS signing secrets are set, a release also carries a development-signed `Boson-ios.ipa` and its over-the-air manifest `Boson-ios.plist`, installable only on the registered test iPhones via `itms-services://?action=download-manifest&url=https://github.com/boson-chat/boson/releases/download/vX.Y.Z/Boson-ios.plist`. Its embedded provisioning profile makes those devices' UDIDs and the developer's name public: see [docs/ios-release.md](docs/ios-release.md). The backend image is released from [boson-chat/backend](https://github.com/boson-chat/backend).

## Useful one-shots

```bash
make engine-build       # build engine/cmd/engine binary → bin/engine
make engine-connect SERVER=irc.libera.chat NICK=alice
                        # smoke test — no client needed

make hooks-install      # install the pre-commit hook (go vet + tests + typecheck)
```

## Troubleshooting

- **Sign-in says it can't reach the sign-in service** — start the auth service: `make auth-up` (and `make client-env`).
- **Engine log panel inside Server settings shows "no entries"** — the engine binary isn't running, or the discovery file at `~/.boson/engine.json` is stale. Restart `make engine-serve`.
- **Connection drops with no error in the splash** — open Server settings → Engine log. The raw IRC frames are there, including any 4xx/5xx server replies.
- **`CORS policy: Method PUT is not allowed`** — restart the backend (boson-chat/backend) after a backend code change.
- **WSL: identity won't persist across restarts** — no keychain available; the app silently falls back to a machine-derived AES-GCM key. Fine for dev.

## Layout reference

The `screens/` and `design-systems/` folders at the repo root hold the original visual mockups (HTML + tokens.css). They're the source of truth for the look — the client implementation should match them, not the other way around.


## License

Copyright (C) 2026 bludot / the boson authors

Licensed under the [GNU Affero General Public License v3.0](LICENSE) only (`AGPL-3.0-only`). Third-party code keeps its own license; see [NOTICE](NOTICE). mermaid's ELK diagram layout (elkjs, EPL-2.0) is left out of the app for license reasons: diagrams use the default dagre layout.

In plain English: if you run a modified version of this software as a network service, you must offer its source code to the people who use that service.
