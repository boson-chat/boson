# IRC-Based Discord-Like Platform — Project Summary

## Vision

A **desktop chat app** that looks and feels like Discord, built on top of real IRC infrastructure. End users never know it's IRC. Server owners get the openness and self-hostability of IRC. The platform is a **directory + native client** — not a walled garden. Power users can still connect with any IRC client if they want.

## Product Surface

- **Native desktop app** (Electron frontend + Go local process), distributed for macOS / Windows / Linux
- **No web client** for MVP
- **UI**: Discord clone — channel list, message view, user list, DMs, notifications, settings. Goal is to abstract IRC away entirely from the normal user
- **No hosted IRC servers for MVP** — directory only. Self-hosters bring their own
- **Free** for now; monetization deferred

## Three User Types

1. **Self-hosting server owner** — runs their own IRCd, registers with directory via DNS TXT
2. **End user** — installs app, signs up, browses directory, joins servers, chats
3. **(Deferred) Zero-ops server owner** — hosted IRCds in k8s, added later

## Architecture

All three components below live in a single monorepo (`boson/`), one top-level folder each:

- **Electron client** → `client/`
- **Local Go process (engine)** → `engine/` (binary at `engine/cmd/engine/`; packages `engine/ipc/`, `engine/irc/`)
- **Backend** → `backend/` (binary at `backend/cmd/server/`; packages `backend/http/`, `backend/db/`, `backend/internal/`, `backend/config/`)

Supabase + infra (`supabase/`, `infra/`, `Makefile`, `Dockerfile`, `docker-compose.yml`) stay at the repo root.

### Client (desktop app)

**Electron frontend** — UI, directory browsing, profile management, settings. Talks directly to the AWS backend for non-IRC features.

**Local Go process** — IRC client engine, crypto, OS keychain access, identity sync. Runs alongside Electron.

**IPC**: localhost WebSocket between Electron and Go.

**API split:**

- **Electron → AWS backend (HTTPS + JWT)**: directory, search, server registration, profile updates, reports
- **Electron → Go (localhost WebSocket)**: IRC actions (connect, send, join, leave), event streams, identity sync triggers
- **Go → AWS backend (HTTPS + JWT, JWT shared from Electron)**: identity sync (fetch/update `encrypted_user_secret`, register new servers)
- **Go → IRC servers (TCP + TLS)**: raw IRC protocol, SASL auth

**Why this split:** Go owns the stable primitives (IRC, crypto). Electron iterates fast on UI/directory features without Go releases. Go updates happen rarely.

### Backend

- **Supabase Auth** for login (email/password, OAuth, TOTP 2FA, password reset, JWT issuance)
- **AWS Postgres** for all app data — `users`, `servers`, `user_server_links`, `handle_changes`, `reports`
- **Lazy user-row creation** on first authenticated API call
- **Backend service** (Go) sitting in front of Postgres, verifying JWTs, enforcing auth on every query (no RLS since data isn't in Supabase)

### Self-Hosted IRC Servers

- Self-hosters run any IRCd (ergo recommended, but anything that supports SASL works)
- Expose IRC over TCP+TLS (standard port 6697 or any port they want)
- **No WebSocket required** (native Go process speaks raw IRC)
- Register with directory via DNS TXT verification
- Periodic health checks; "currently offline" displayed but not delisted
- Periodic re-verification (weekly); lapsed → hidden with grace period
- IP-only servers rejected

## Identity Model

### Core scheme: derived per-server passwords

- At signup, generate 32-byte random `user_secret`
- Encrypt with KEK derived from user's platform password (Argon2id)
- Stored as `encrypted_user_secret` in AWS Postgres (you hold ciphertext, can't decrypt)
- Decryption happens in the local Go process, never on the backend
- Derive per-server password as `HMAC-SHA256(user_secret, "irc-password" || server_id)` where `server_id` is your directory's UUID
- Each server sees a unique, random password

### Storage at rest (client side)

- OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux) holds something useful — likely the KEK or a session token
- `encrypted_user_secret` itself can be cached locally for offline use but always re-fetched on key rotation

### No recovery

- Lose platform password → `user_secret` is gone forever
- Platform provides a **guided reclaim flow**: helps user reclaim each server identity via NickServ recovery (email or admin contact)

### No credential export

- User never sees derived passwords
- Escape hatch: switch any server to **manual mode**. Go runs `/msg NickServ SET PASSWORD <new>`, stops managing that server. User stores manual password locally (encrypted via OS keychain)

### Schema

```sql
users(
  id uuid primary key,                  -- = Supabase auth.users.id
  handle text unique not null,          -- network-wide username
  display_name text,                    -- optional, ~32 chars
  avatar_storage_key text,              -- nullable, points to your storage bucket
  is_discoverable bool default true,
  encrypted_user_secret bytea not null,
  handle_changed_at timestamptz,
  created_at timestamptz default now()
)

servers(
  id uuid primary key,
  hostname text, port int, tls bool,
  name text, description text,
  tags text[] default '{}',
  languages text[] default '{}',
  is_nsfw bool default false,
  is_featured bool default false,
  verification_status text,             -- 'pending' | 'verified' | 'lapsed'
  verification_token text,
  verification_last_checked_at timestamptz,
  health_status text,                   -- 'up' | 'down' | 'unknown'
  health_last_checked_at timestamptz,
  user_count int,
  user_count_updated_at timestamptz,
  registered_by uuid references users(id),
  registered_at timestamptz default now(),
  search_vector tsvector generated always as (...) stored
)

user_server_links(
  user_id uuid references users(id),
  server_id uuid references servers(id),
  nick text,
  management_mode text,                 -- 'derived' | 'manual'
  visibility text default 'private',    -- 'public' | 'private'
  registered_at timestamptz,
  last_sasl_success_at timestamptz,
  status text,                          -- 'active' | 'creds_out_of_sync' | 'unregistered'
  primary key (user_id, server_id)
)

handle_changes(
  user_id uuid references users(id),
  old_handle text,
  new_handle text,
  changed_at timestamptz,
  redirect_until timestamptz            -- changed_at + 90 days
)

reports(
  id uuid primary key,
  reporter_id uuid references users(id),
  target_type text,                     -- 'user' | 'server'
  target_id uuid,
  reason text,
  created_at timestamptz default now(),
  status text default 'open'            -- 'open' | 'reviewed' | 'actioned' | 'dismissed'
)
```

### Handle policy

- Changes allowed **once per 90 days**
- Old handle reserved for 90-day cooldown, redirects to new handle during cooldown
- After cooldown, old handle becomes available again
- Reserved word list at signup (`admin`, `support`, etc.)
- Homoglyph confusable detection at signup
- Minimum length 3 chars

## Directory & Discovery

### Server discovery (MVP features)

- Full-text **search** on name + description + tags (Postgres tsvector + GIN)
- **Tags** — hybrid free-form with autocomplete from existing tags
- **Language filter** — defaults to user's system language
- **NSFW flag** — set by server owner, default-excluded from search, user can toggle
- **Featured** column exists, UI deferred until directory has 30+ servers
- **Activity indicator** — "23 users online" from periodic LUSERS check
- **Sort options** — Most users (default), Newest, Recently active
- **Verified-since date** for trust signal

### User discovery (network-wide)

- Each user has a globally unique `handle` (platform-wide, separate from IRC nicks)
- Profile lookup by handle returns: display name, avatar, list of `public` server links
- **Per-server visibility flag** on `user_server_links` — default `private`, opt-in to `public`
- **Profile-level discoverability flag** on `users` — `is_discoverable`, default true
- No friends list, no cross-server social graph in MVP

## Profile Fields (MVP)

- `handle` (network-wide username)
- `display_name` (optional, free-text, ~32 chars)
- `avatar` (self-hosted on your storage bucket, validated + EXIF-stripped + optional image moderation API)

**Deferred until moderation capacity exists:** bio, pronouns, links, custom themes, status, banners

## Moderation

- **Reports table** from day one (covers users and servers)
- Abusive servers: removed from directory
- Avatar pre-screening via image moderation API (AWS Rekognition / Google Vision SafeSearch)

## Build Order (Suggested)

1. **Auth + identity scaffolding** — Supabase Auth, AWS Postgres `users` table, `encrypted_user_secret` flow end-to-end (no IRC yet)
2. **Local Go process** — basic IRC client (connect, SASL, send/receive) talking to a known test server
3. **Electron ↔ Go bridge** — localhost WebSocket, basic chat UI showing messages from Go
4. **Wire identity to Go** — derive password, SASL into test server using full crypto path
5. **Self-hoster registration** — DNS TXT verification flow, backend API
6. **Directory browse + join** — pick server from directory, auto-register nick, join
7. **UI polish** — channel list, user list, DMs, notifications, settings
8. **Reclaim flow + manual mode** — both edge cases for identity management
9. **Reports + moderation tooling**

---

## What's Left to Decide / Defer

You've answered almost everything. Remaining items are mostly "deferred until later" rather than "blocking decisions":

1. **UI design language** — Discord clone for MVP, custom design later. The interesting product question: **how do you hide that it's IRC?** Some things don't map cleanly:
   - **Channel creation** — Discord users expect to click "+" and instantly have a channel. In IRC, anyone can `/join #anything` and it exists. Who's the "owner"? IRC has ChanServ for registration. Probably: clicking "+" sends `/join` *and* registers with ChanServ on the user's behalf
   - **Roles/permissions** — Discord has rich roles; IRC has channel modes (`+o`, `+v`, `+h`) and ban masks. Mapping is tedious but doable
   - **Server-level "owner"** — IRC doesn't have a clean concept. Self-hoster owns the IRCd; on hosted servers (later), assign owner status somehow
   - **Things IRC can't do** — voice/video, threads, reactions, rich embeds, slash commands, integrations. Either skip or build a parallel metadata layer (your server stores reactions linked to IRC message IDs, etc.). At some point you're building a non-IRC layer that just happens to use IRC for text transport

2. **Electron distribution** — code signing, auto-update via electron-updater, separate Go binary update mechanism. Deferred to distribution time.

3. **k8s for hosted servers** — entirely deferred until after MVP.

4. **Monetization** — deferred.
