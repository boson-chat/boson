# Boson

A desktop chat app that feels like Discord, built on real IRC. See [PRD.md](./PRD.md) for the product vision.

## Architecture

Three components in one monorepo:

```
client/             Electron + Preact renderer (the app users see)
engine/             Local Go IRC process — bridges WebSocket ↔ IRC for the client
backend/            Go HTTP API — Supabase auth, server directory, user sessions
packages/shared/    @boson/shared — design system (Button, Card, …) shared with the website
website/            Public marketing site (Preact + Vite)
```

## Run it locally

### Prerequisites

- **Go** ≥ 1.27
- **Node** ≥ 22.12 + npm (required by Electron 44)
- **Docker** + `docker compose` (Postgres + Supabase Auth + ergo IRCd run in containers)
- **Supabase CLI** — `brew install supabase/tap/supabase` or `npm i -g supabase`

### First-time setup

```bash
make dev-up
```

That single command spins up everything needed:

- Postgres on `:5432` (via `docker compose`)
- Supabase Auth stack (`supabase start`) — Studio on `http://localhost:54323`
- Local ergo IRCd on `:6667` (under the `testing` profile, so it doesn't run in production stacks)
- Runs `migrate-up` on the boson DB
- Runs `seed-dev` to insert a "Local Ergo" entry into the server directory

You only need to run this once per machine. Subsequent boots are just `make up && make supabase-up && make ergo-up` (or `make dev-up` again — all sub-steps are idempotent).

### Day-to-day: four shells

After `make dev-up`, run these in **four separate terminals**:

```bash
# 1. Boson HTTP API (auth, directory, user sessions)
make run

# 2. Local IRC engine (WebSocket bridge between the renderer and IRC)
make engine-serve

# 3. Electron client (renderer + main)
make client-dev

# 4. (Optional) Fake user that types into a channel — useful for verifying
#    the IRCv3 typing indicator + unread badges without a second human.
make typingbot
```

The client reads engine discovery from `~/.boson/engine.json` (or `$XDG_RUNTIME_DIR/boson/engine.json`); `make client-dev` automatically merges its URL + token into `client/.env` if the engine is up.

### Skip auth (guest mode)

On the login screen, click **"Continue without an account"** and pick a nick — you'll land directly in the directory. No backend `/me`, no encrypted identity, no sync. Useful for kicking the tyres.

### Add a server that isn't in the directory

In the directory, click **Advanced** in the filter row → **+ Add server manually**. Enter hostname/port/TLS/name. Local entries are stored in `localStorage` only — never published to the backend directory.

### Build the client

```bash
make client-build       # production bundle in client/out/
```

## Website (marketing site)

The public marketing site lives at `website/` — Preact + Vite + TypeScript, no backend. It shares the design system (`@boson/shared`) with the client, so `Button`, `Card`, `Badge`, `BosonGlyph`, tokens, etc. stay visually in sync.

### Run the dev server

```bash
cd website
npm install             # only the first time (npm workspaces handles @boson/shared)
npm run dev             # vite dev server on http://localhost:5174
```

The site has no backend dependencies — you can run it standalone without `make dev-up`.

### Build for deploy

```bash
cd website
npm run build           # static bundle in website/dist/
npm run preview         # serve the built dist/ locally for a final smoke
```

`vite build` produces a fully static `dist/` folder you can host anywhere (Netlify, Cloudflare Pages, GitHub Pages, S3+CloudFront).

### Routes

`preact-iso` handles routing client-side. Pages live in `website/src/pages/`:

| Route | Page |
|---|---|
| `/` | `IndexPage` — landing + feature highlights |
| `/about` | `AboutPage` |
| `/docs` | `DocsPage` |
| `/download` | `DownloadPage` |
| `*` | `NotFoundPage` |

### Exposing the dev server publicly (ngrok / Cloudflare tunnel)

Vite's `server.allowedHosts` is set to `true` in `website/vite.config.ts`, so any tunnel URL works without further config. Run `ngrok http 5174` (or your tunnel of choice) and share the URL.

### Typecheck

```bash
cd website
npm run typecheck       # tsc --noEmit
```

## Run the tests

```bash
make test               # Go + TS unit tests (requires Postgres up)
make test-go            # Just Go
make test-client        # Just renderer (vitest)
make test-e2e           # Playwright E2E (needs the full dev stack + engine built)
make test-e2e-app       # Real Electron app E2E (needs only Docker — see below)
```

### End-to-end tests (real app)

`client/tests/e2e-app/` drives the **built Electron app** — main process,
preload, renderer and its own Go engine sidecar — with Playwright's
`_electron` API. Guest specs: manually added server → chat with a raw IRC
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
npm run build:e2e-app    # → client/out-e2e (+ host engine sidecar); rerun after code changes
npm run test:e2e:app     # add e.g. `-- bouncer` to run one spec file
node scripts/e2e-stack.mjs status            # what's running where
node scripts/e2e-stack.mjs restart-backend   # after backend code changes
```

Needs docker, Go and the Supabase CLI. `make test-e2e-app-up`
(`client/scripts/e2e-stack.mjs up`, ~10s warm, idempotent) brings up the
isolated stack; endpoints are in `infra/e2e/stack.json`:

| Piece | Where | Notes |
| --- | --- | --- |
| ergo | `127.0.0.1:16667` | NickServ registration mails the catch-all Mailpit |
| ZNC 1.9 | `127.0.0.1:16501` | users `tester1`..`tester8` / `pw`, network `ergo`; leased one per test |
| Postgres | `127.0.0.1:16432` | the backend's DB (`boson`/`boson`), migrated on `up` |
| Mailpit (catch-all) | SMTP `:11025`, POP3 `:11110`, UI `http://127.0.0.1:18025` | boson.chat catch-all: ergo writes, the backend's nick-claim worker drains |
| MinIO | `http://127.0.0.1:19000` (console `:19001`) | R2 stand-in, bucket `boson` (public read) |
| Supabase Auth | `http://127.0.0.1:55321` | CLI project `boson-e2e` (`infra/e2e/supabase/`): Postgres + GoTrue + Kong only; email confirmation on |
| Mailpit (auth) | `http://127.0.0.1:55324` | the users' inboxes: Supabase confirmation / recovery mail |
| Backend | `http://127.0.0.1:13000` | built from this checkout (`boson_dev`, `SKIP_DNS_VERIFY`), run on the host |

Isolation, so it can run next to a live dev stack:

- Compose project `boson-e2e` and Supabase project `boson-e2e` (own
  containers, volumes, network, ports) — the dev `boson-*` containers and
  the `supabase/` project are never touched. Compose state is tmpfs;
  `down` stops Supabase with `--no-backup`.
- The backend runs from `infra/e2e/.run/` (binary, pid, log) with all config
  from env, so a local `backend/config/config.dev.json` (which may hold real
  mail credentials) is never loaded; `down` only kills the PID it started.
- The app is built into `client/out-e2e/` (`E2E_OUT_DIR` to change; not
  `client/out/`, which `electron-vite dev` owns) with the backend/Supabase
  URLs pinned to the e2e stack, so a local `client/.env` can't leak in.
  Guest specs pass without the stack's account half running.
- Every test launches the app with a throwaway `HOME`, `XDG_RUNTIME_DIR` and
  `--user-data-dir`, plus `--use-mock-keychain` on macOS — your
  `~/.boson/engine.json`, real app profile and keychain are left alone.
  `shell.openExternal` is stubbed so nothing opens in your browser.
- Tests use random channels, nicks, emails and handles and lease their own
  ZNC user, so they run in parallel: 4 workers locally, 1 in CI
  (`E2E_WORKERS` overrides). Several people can share one stack with their
  own `E2E_OUT_DIR` / `E2E_RESULTS_DIR` / `E2E_COVERAGE_DIR`.

Failures leave a screenshot, a Playwright trace and the main-process +
engine log in `client/test-results/e2e-app/` (`npx playwright show-trace
<zip>`); the backend logs to `infra/e2e/.run/backend.log`.

CI runs the suite against the Wails desktop shell instead
(`.github/workflows/e2e.yml`, locally `make test-e2e-wails`, or
`make test-e2e-wails-coverage`): `desktop/` built as a server-mode binary,
driven in headless Chromium on Linux. Specs that need a native window or
Electron itself skip there.

#### Coverage

```bash
make test-e2e-app-coverage   # coverage stack + build + run → client/coverage/e2e/

# Iterating (stack already up with E2E_COVERAGE=1):
cd client
E2E_COVERAGE=1 npm run build:e2e-app
npm run test:e2e:app:coverage
```

`E2E_COVERAGE=1` builds the bundles with source maps (renderer unminified),
the engine with `go build -cover` and (on `e2e-stack.mjs up`) the backend
with `go build -cover`, then measures all four layers across every launch
in the run (relaunches included):

- **Renderer** — V8 precise coverage, started on each window before its first
  script runs (`tests/e2e-app/coverage/electron-hook.cjs`, preloaded into the
  main process with `-r`) and taken just before the app closes.
- **Main + preload** — `NODE_V8_COVERAGE` for the main process (flushed on a
  graceful quit); the sandboxed preload runs in the renderer's V8 and comes
  with the renderer data.
- **Engine** — `GOCOVERDIR`, inherited by the sidecar; counters are written
  when it exits on the app's SIGTERM.
- **Backend** — the stack's backend runs for the whole session, so the report
  sends it SIGUSR1 and it writes a counter snapshot
  (`backend/cmd/server/coverflush_e2e.go`, `boson_e2ecover` builds only).
  Counters span the backend's lifetime — `make test-e2e-app-coverage`
  restarts it so they cover just that run (plus `migrate up`). Skipped with a
  warning when the backend isn't a coverage build.

Reports are mapped back to `client/src/…`, `engine/…` and `backend/…`
(node_modules, tests and the shared workspace package are excluded):
`renderer/`, `main/`, `engine/` and `backend/` each hold an `index.html` and
`lcov.info`, and `summary.md` has
per-layer totals plus the least-covered files. Expect about 10% overhead.
CI runs with coverage on, adds `summary.md` to the job summary and uploads
the reports as the `e2e-app-coverage` artifact. A coverage build left in
`client/out-e2e` still works for a plain `npm run test:e2e:app`; rebuild
without the flag for representative timings.

## Useful one-shots

```bash
make migrate-up         # apply DB migrations
make migrate-down       # roll back one migration
make migrate-create name=add_foo_table

make engine-build       # build engine/cmd/engine binary → bin/engine
make engine-connect SERVER=irc.libera.chat NICK=alice
                        # smoke test — no client needed

make seed-dev           # re-seed Local Ergo into the directory
make hooks-install      # install the pre-commit hook (go vet + tests + typecheck)
```

## Troubleshooting

- **"Supabase not running"** — start it: `make supabase-up`.
- **`make seed-dev` errors** — Postgres isn't up yet; run `make up` first.
- **Engine log panel inside Server settings shows "no entries"** — the engine binary isn't running, or the discovery file at `~/.boson/engine.json` is stale. Restart `make engine-serve`.
- **Connection drops with no error in the splash** — open Server settings → Engine log. The raw IRC frames are there, including any 4xx/5xx server replies.
- **`CORS policy: Method PUT is not allowed`** — restart `make run` after a backend code change.
- **WSL: identity won't persist across restarts** — no keychain available; the app silently falls back to a machine-derived AES-GCM key. Fine for dev.

## Layout reference

The `screens/` and `design-systems/` folders at the repo root hold the original visual mockups (HTML + tokens.css). They're the source of truth for the look — the client implementation should match them, not the other way around.


claude --resume 0bc9161b-c730-4cca-a78d-4e02b9989201
