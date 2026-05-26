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

- **Go** ≥ 1.22
- **Node** ≥ 20 + npm
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
```

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



resume: `claude --resume f0cd63a9-7de1-4cb8-b19e-bd70bf52173e`
