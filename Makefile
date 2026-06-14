.PHONY: setup up down logs build tidy run migrate-up migrate-down migrate-create reset \
        supabase-check supabase-init supabase-up supabase-down supabase-status supabase-reset \
        ergo-up typingbot seed-dev dev-up dev-down \
        client-install client-env client-dev client-build \
        engine-build engine-connect engine-serve engine-env sidecar-build \
        test test-go test-client test-e2e hooks-install \
        test-e2e-services test-e2e-services-ergo test-e2e-services-anope test-e2e-services-atheme

setup: tidy up
	@echo "Waiting for postgres..."
	@sleep 3
	$(MAKE) migrate-up

tidy:
	go mod tidy

up:
	docker compose up -d postgres
	@echo "Postgres is up on localhost:5432"

down:
	docker compose down

logs:
	docker compose logs -f

build:
	docker compose build api

stack-up:
	docker compose up -d --build

stack-down:
	docker compose down -v

run:
	go run ./backend/cmd/server serve

migrate-up:
	go run ./backend/cmd/server migrate up

migrate-down:
	go run ./backend/cmd/server migrate down

migrate-create:
	@if [ -z "$(name)" ]; then echo "usage: make migrate-create name=create_users_table"; exit 1; fi
	@mkdir -p backend/db/migrations
	@seq=$$(printf "%06d" $$(( $$(ls backend/db/migrations 2>/dev/null | grep -E '^[0-9]+_' | head -n 1 | cut -d_ -f1 | sed 's/^0*//' || echo 0) + 1 ))); \
	touch backend/db/migrations/$${seq}_$(name).up.sql backend/db/migrations/$${seq}_$(name).down.sql; \
	echo "Created backend/db/migrations/$${seq}_$(name).{up,down}.sql"

reset: stack-down setup

# ----- Supabase (local auth stack) -----

supabase-check:
	@command -v supabase >/dev/null 2>&1 || { \
		echo "supabase CLI not found."; \
		echo "Install: brew install supabase/tap/supabase   (or)   npm i -g supabase"; \
		echo "Or grab a binary: https://github.com/supabase/cli/releases"; \
		exit 1; \
	}

supabase-init: supabase-check
	@if [ ! -f supabase/config.toml ]; then \
		echo "==> supabase init"; \
		supabase init; \
	else \
		echo "==> supabase already initialized"; \
	fi

supabase-up: supabase-init
	supabase start
	@echo ""
	@echo "Supabase is up. Studio: http://localhost:54323"
	@echo "Run 'make run' to start boson with the local JWT secret wired in."

supabase-down: supabase-check
	supabase stop

supabase-status: supabase-check
	supabase status

supabase-reset: supabase-check
	supabase stop --no-backup || true

# ----- Combined dev flows -----

# Full local dev stack: boson Postgres + Supabase Auth + local ergo IRCd
# + mailpit (the inbound mailbox the nick-claim IMAP worker reads).
# ergo and mailpit aren't strictly required for every dev session, but
# the running cost is low and including them by default makes the
# nick-claim flow + chat e2e tests "just work" without a separate
# `docker compose --profile X up` step.
dev-up: tidy up supabase-up ergo-up mailpit-up minio-up
	@$(MAKE) migrate-up
	@$(MAKE) seed-dev

ergo-up: mailpit-up
	docker compose --profile testing up -d ergo
	@echo "ergo is up on localhost:6667 (mailto callback → mailpit:1025)"

# Mailpit — local SMTP receive (port 1025) + POP3 read (1110) + a
# web UI at http://localhost:8025. The backend's nickclaim worker
# polls POP3 here in dev and against PurelyMail in production; same
# code path either way (POP3 because mailpit doesn't speak IMAP).
# Auth is `dev:dev` — matches the .env.example defaults so the
# backend connects out of the box.
mailpit-up:
	docker compose --profile dev-mail up -d mailpit
	@echo "mailpit is up — SMTP:1025  POP3:1110 (dev:dev)  UI: http://localhost:8025"

# MinIO — local S3-compatible store for the avatar/profile-image feature.
# The backend points its CLOUDFLARE_R2_* config here in dev (see
# backend/config/config.dev.json). minio-setup creates the `boson` bucket
# and makes it anonymously readable so avatar URLs load in the client.
minio-up:
	docker compose --profile dev-storage up -d minio minio-setup
	@echo "minio is up — S3:9000  console:9001 (minioadmin/minioadmin)  bucket: boson"

# Inserts the local ergo IRCd into the directory so it shows up in Boson's
# server browser. Idempotent (ON CONFLICT DO UPDATE). Dev-only — not part of
# the migration set, so production directories aren't polluted with localhost.
seed-dev:
	@docker compose exec -T postgres psql -U boson -d boson -v ON_ERROR_STOP=1 < backend/db/seeds/dev-ergo.sql
	@echo "seeded Local Ergo into the directory (localhost:6667)"

# Fake second user that emits IRCv3 `+typing=active` TAGMSGs on a loop. Run
# this in another terminal after `make ergo-up`, then point Boson at
# localhost:6667 and /join #boson-typing-test to see the typing indicator UI.
typingbot:
	go run ./engine/cmd/typingbot

dev-down: supabase-down down

# ----- Electron client -----

client-install:
	cd client && npm install

# Regenerates client/.env from the local Supabase ANON_KEY. Safe to re-run.
client-env: supabase-check
	@ANON=$$(supabase status -o env 2>/dev/null | grep '^ANON_KEY=' | cut -d= -f2- | tr -d '"'); \
	if [ -z "$$ANON" ]; then echo "Supabase not running. Run 'make supabase-up' first."; exit 1; fi; \
	printf 'VITE_SUPABASE_URL=http://localhost:54321\nVITE_SUPABASE_ANON_KEY=%s\nVITE_BOSON_API_URL=http://localhost:3000\n' "$$ANON" > client/.env; \
	echo "Wrote client/.env"

client-dev: client-env
	@DISCOVERY="$${XDG_RUNTIME_DIR:-$$HOME/.boson}/boson/engine.json"; \
	if [ ! -f "$$DISCOVERY" ]; then DISCOVERY="$$HOME/.boson/engine.json"; fi; \
	if [ -f "$$DISCOVERY" ]; then $(MAKE) engine-env; fi
	cd client && npm run dev

client-build:
	cd client && npm run build

# ----- IRC engine (local Go process) -----

engine-build:
	go build -o bin/engine ./engine/cmd/engine

# Rebuild the sidecar engine binaries that `make client-dev` (and the
# packaged app) spawn from `client/resources/engine/`. The binaries
# here are committed so a clean checkout can `npm run dev` without a
# Go toolchain, but they go stale whenever `engine/` source changes.
# Run this after engine/ edits OR before testing renderer ↔ engine
# IPC changes — `make client-dev` won't pick up engine changes
# otherwise.
#
# Both targets cross-compile via `GOOS=...` so a single dev machine
# can rebuild the Windows binary too (Go cross-compiles cleanly
# without cgo).
sidecar-build:
	@echo "Building sidecar engine binaries for client/resources/engine/..."
	GOOS=linux   GOARCH=amd64 go build -o client/resources/engine/engine-linux-amd64       ./engine/cmd/engine
	GOOS=linux   GOARCH=arm64 go build -o client/resources/engine/engine-linux-arm64       ./engine/cmd/engine
	GOOS=windows GOARCH=amd64 go build -o client/resources/engine/engine-windows-amd64.exe ./engine/cmd/engine
	@ls -la client/resources/engine/

# Run the engine WebSocket bridge (foreground). Writes discovery to
# ~/.boson/engine.json (or $XDG_RUNTIME_DIR/boson/engine.json).
engine-serve:
	go run ./engine/cmd/engine serve

# After `make engine-serve` is running, merge engine URL+token into client/.env.
# Preserves Supabase keys already there.
engine-env:
	@DISCOVERY="$${XDG_RUNTIME_DIR:-$$HOME/.boson}/boson/engine.json"; \
	if [ ! -f "$$DISCOVERY" ]; then DISCOVERY="$$HOME/.boson/engine.json"; fi; \
	if [ ! -f "$$DISCOVERY" ]; then echo "No engine discovery file. Start 'make engine-serve' first."; exit 1; fi; \
	URL=$$(grep -oE '"url"[[:space:]]*:[[:space:]]*"[^"]+"' "$$DISCOVERY" | head -1 | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/'); \
	TOKEN=$$(grep -oE '"token"[[:space:]]*:[[:space:]]*"[^"]+"' "$$DISCOVERY" | head -1 | sed 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/'); \
	if [ -z "$$URL" ] || [ -z "$$TOKEN" ]; then echo "Discovery file malformed: $$DISCOVERY"; exit 1; fi; \
	touch client/.env; \
	grep -v '^VITE_ENGINE_' client/.env > client/.env.tmp || true; \
	echo "VITE_ENGINE_URL=$$URL" >> client/.env.tmp; \
	echo "VITE_ENGINE_TOKEN=$$TOKEN" >> client/.env.tmp; \
	mv client/.env.tmp client/.env; \
	echo "Wrote VITE_ENGINE_URL and VITE_ENGINE_TOKEN to client/.env"

# Quick smoke connect — e.g.
#   make engine-connect SERVER=irc.myelinbots.com NICK=$(whoami)
# Optional: PASSWORD=... JOIN=#test (comma-separated)
engine-connect:
	@if [ -z "$(SERVER)" ] || [ -z "$(NICK)" ]; then \
		echo "usage: make engine-connect SERVER=<host> NICK=<nick> [PORT=6697] [PASSWORD=...] [JOIN=#a,#b]"; \
		exit 1; \
	fi
	go run ./engine/cmd/engine connect \
		--server "$(SERVER)" \
		--port "$${PORT:-6697}" \
		--nick "$(NICK)" \
		$(if $(PASSWORD),--password "$(PASSWORD)") \
		$(if $(JOIN),--join "$(JOIN)")

# ----- Tests -----

# Run Go + TS unit tests. Skip E2E (run via `make test-e2e`).
test: test-go test-client

# Go test suite — needs Postgres running on :5432 (make up).
# -p 1 serializes packages because they share the test database.
test-go:
	go test -p 1 ./...

# Client unit tests via Vitest (renderer code only — no Electron).
test-client:
	cd client && npm test

# Playwright E2E. Requires:
#   - make dev-up (postgres + supabase + ergo)
#   - make run (boson backend in another shell)
# Builds the engine binary first so playwright's webServer can launch it
# without paying the `go run` compile cost on every test run.
test-e2e: engine-build
	cd client && npm run test:e2e

# ----- Services e2e (live IRC services packages) -----
#
# Drives real REGISTER / IDENTIFY / DROP / INFO flows against Ergo,
# Anope, and Atheme containers — captures NickServ replies to JSON
# fixtures under engine/internal/services_e2e/fixtures/<stack>/. The
# renderer's classifier test then replays those fixtures so the
# pattern table stays honest against ground-truth server output.
#
# Each stack target boots its own docker profile, waits for IRCd
# readiness, runs the per-stack Go tests with the `e2e` build tag.

# Boot Ergo and run its scenarios. Ergo is already wired into the
# `testing` profile in docker-compose.yml. `-v` surfaces per-test
# PASS / FAIL lines so the parent `test-e2e-services` log reads as
# a checklist of what ran (vs. a single package-level "ok").
#
# After the engine-level Go tests pass, we ALSO run the Playwright
# spec (tests/e2e/nickserv-flow.spec.ts) parameterized at this
# stack's IRC endpoint. That's the full Electron → IPC → engine →
# IRC → reply → renderer round-trip; the Go suite only proves the
# bottom half of the pipeline.
test-e2e-services-ergo: ergo-up engine-build seed-dev
	@echo "Waiting for ergo readiness..."
	@timeout 30 bash -c 'until echo > /dev/tcp/127.0.0.1/6667 2>/dev/null; do sleep 0.2; done' || \
		{ echo "ergo never came up on :6667"; exit 1; }
	E2E_ERGO_HOST=127.0.0.1 E2E_ERGO_PORT=6667 \
		go test -tags=e2e -count=1 -v ./engine/internal/services_e2e/ergo/...
	@echo "---- Playwright NickServ flow against ergo ----"
	cd client && E2E_IRC_HOST=127.0.0.1 E2E_IRC_PORT=6667 E2E_STACK_NAME=ergo \
		npx playwright test tests/e2e/nickserv-flow.spec.ts --reporter=list

# Anope + UnrealIRCd. Infra lives under infra/anope/ — the existence
# marker is the unrealircd.conf file (not anope.conf — the Anope side
# splits config across multiple files under infra/anope/conf/).
test-e2e-services-anope: engine-build
	@if [ ! -f infra/anope/unrealircd.conf ]; then \
		echo "Anope e2e infra not yet built — see task #83 (infra/anope/ + docker-compose anope profile)."; \
		exit 1; \
	fi
	docker compose --profile e2e-anope up -d
	@echo "Waiting for anope+unrealircd readiness..."
	@timeout 60 bash -c 'until echo > /dev/tcp/127.0.0.1/6668 2>/dev/null; do sleep 0.5; done' || \
		{ echo "anope+unreal never came up on :6668"; exit 1; }
	@sleep 5  # give Anope's burst link to settle
	@# Seed the directory so the Playwright spec can find the stack
	@# as a `verified` row (public GET /servers filters out pending).
	@docker compose exec -T postgres psql -U boson -d boson -v ON_ERROR_STOP=1 < backend/db/seeds/dev-anope.sql
	E2E_ANOPE_HOST=127.0.0.1 E2E_ANOPE_PORT=6668 \
		go test -tags=e2e -count=1 -v ./engine/internal/services_e2e/anope/...
	@echo "---- Playwright NickServ flow against anope ----"
	cd client && E2E_IRC_HOST=127.0.0.1 E2E_IRC_PORT=6668 E2E_STACK_NAME=anope \
		npx playwright test tests/e2e/nickserv-flow.spec.ts --reporter=list

# Atheme + InspIRCd. Infra in infra/atheme/.
test-e2e-services-atheme: engine-build
	@if [ ! -f infra/atheme/atheme.conf ]; then \
		echo "Atheme e2e infra not yet built — see task #84 (infra/atheme/ + docker-compose atheme profile)."; \
		exit 1; \
	fi
	docker compose --profile e2e-atheme up -d
	@echo "Waiting for atheme readiness..."
	@timeout 60 bash -c 'until echo > /dev/tcp/127.0.0.1/6669 2>/dev/null; do sleep 0.5; done' || \
		{ echo "atheme+inspircd never came up on :6669"; exit 1; }
	@sleep 5
	@docker compose exec -T postgres psql -U boson -d boson -v ON_ERROR_STOP=1 < backend/db/seeds/dev-atheme.sql
	E2E_ATHEME_HOST=127.0.0.1 E2E_ATHEME_PORT=6669 \
		go test -tags=e2e -count=1 -v ./engine/internal/services_e2e/atheme/...
	@echo "---- Playwright NickServ flow against atheme ----"
	cd client && E2E_IRC_HOST=127.0.0.1 E2E_IRC_PORT=6669 E2E_STACK_NAME=atheme \
		npx playwright test tests/e2e/nickserv-flow.spec.ts --reporter=list

# Run every stack in sequence. Stacks without infra skip with a note
# (so a fresh checkout that lacks one of the stacks doesn't fail
# the whole run). Strict on a stack-level failure: if Ergo passes
# but Anope's scenarios fail, the make exits non-zero — that's the
# desired CI signal.
test-e2e-services:
	@echo "===== ergo ====="
	@$(MAKE) test-e2e-services-ergo
	@if [ -f infra/anope/unrealircd.conf ]; then \
		echo "===== anope ====="; \
		$(MAKE) test-e2e-services-anope; \
	else \
		echo "===== anope ===== (skipped — infra/anope/ not present)"; \
	fi
	@if [ -f infra/atheme/atheme.conf ]; then \
		echo "===== atheme ====="; \
		$(MAKE) test-e2e-services-atheme; \
	else \
		echo "===== atheme ===== (skipped — infra/atheme/ not present)"; \
	fi
	@echo "===== services e2e — done ====="

# ----- Git hooks -----

hooks-install:
	@mkdir -p .githooks
	@cp scripts/pre-commit .githooks/pre-commit
	@chmod +x .githooks/pre-commit
	@git config core.hooksPath .githooks
	@echo "Pre-commit hook installed. Tests will run on every commit."

