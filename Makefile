.PHONY: setup up down logs build tidy run migrate-up migrate-down migrate-create reset \
        supabase-check supabase-init supabase-up supabase-down supabase-status supabase-reset \
        ergo-up typingbot seed-dev dev-up dev-down \
        client-install client-env client-dev client-build \
        engine-build engine-connect engine-serve engine-env \
        test test-go test-client test-e2e hooks-install

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
# (the ergo container is required by chat + engine E2E specs).
dev-up: tidy up supabase-up ergo-up
	@$(MAKE) migrate-up
	@$(MAKE) seed-dev

ergo-up:
	docker compose --profile testing up -d ergo
	@echo "ergo is up on localhost:6667"

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

# ----- Git hooks -----

hooks-install:
	@mkdir -p .githooks
	@cp scripts/pre-commit .githooks/pre-commit
	@chmod +x .githooks/pre-commit
	@git config core.hooksPath .githooks
	@echo "Pre-commit hook installed. Tests will run on every commit."

