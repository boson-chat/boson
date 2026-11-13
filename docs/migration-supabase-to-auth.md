# Migrating accounts from Supabase Auth to the boson auth service

Boson's accounts move from Supabase Auth to the boson auth service
([boson-chat/auth](https://github.com/boson-chat/auth), production
`https://auth.boson.chat`). It is a **hard cutover**: once the new backend is
deployed it accepts only auth-service tokens, and clients from before the
cutover stop working until they update and sign in again.

Supabase was only used for Auth (no database, storage, realtime or edge
functions), so nothing else moves.

## What changes

| | Before | After |
|---|---|---|
| Sign-up | email + password (Supabase) | username (an IRC nick) + email + password |
| Sign-in | email + password | username **or** email + password |
| Email verification | Supabase link → boson.chat/auth/confirmed → `boson://auth/confirmed` deep link signs the app in | auth-service link → its own `/verify-email` page; the user returns to the app and presses Continue |
| Password reset | Supabase recovery mail | "Forgot password?" in the app → auth-service `/reset-password` page |
| Access token | Supabase JWT (ES256), `sub` = uuid | EdDSA JWT, `typ: at+jwt`, `iss` = `https://auth.boson.chat`, `aud` = `boson`, `sub` = `usr_<ULID>`, 15 min |
| Refresh token | supabase-js, localStorage | rotating, single-flight refresh, stored in the OS keychain (secure store) |
| Backend config | `SUPABASE_JWKS_URL` | `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE` |
| Client config | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | `VITE_AUTH_URL` (default `https://auth.boson.chat`) |

### Identity mapping

Every boson table keys users by a uuid (`users.id`, and `user_id` /
`registered_by` / `reporter_id` columns everywhere) that used to be the
Supabase user id. Rather than rewrite those, migration `000010` adds one
table:

```sql
auth_identities (auth_user_id text PRIMARY KEY,  -- the token's sub, usr_<ULID>
                 user_id uuid NOT NULL UNIQUE,   -- boson's id
                 source text,                     -- supabase_import | auto
                 created_at timestamptz)
```

- The import tool writes one row per Supabase account: `usr_… → <old Supabase
  uuid>`. Their profile, servers, sessions, NickServ and bouncer secrets keep
  resolving with no data change.
- An account created on the auth service later gets a row on its first API
  request, with `user_id = UUIDv5(namespace, sub)` (version 5, so it can't
  equal a Supabase v4 id; deterministic, so concurrent first requests agree).
- The backend resolves `sub → user_id` per request (cached in memory:
  mappings never change).
- No foreign key to `users`: the mapping exists before the profile
  (`POST /me`) and survives `DELETE /me`.

## The import tool

`server import-supabase-users` (the backend binary; in a checkout:
`go run ./backend/cmd/server import-supabase-users`). It reads boson's
database through the usual `DB*` env, and writes the auth service's database
directly (the auth service has no import API).

```text
--export FILE                Supabase auth.users export: .csv (with header), .json, .jsonl
--auth-db URL                auth service Postgres (default $AUTH_DATABASE_URL)
--passwords bcrypt|none      bcrypt: copy Supabase's bcrypt hashes (needs the
                             auth-service change below); none: no passwords
--dry-run                    plan only; writes the mapping file, changes nothing
--mapping-out FILE           CSV: supabase_id, auth_user_id, action, username,
                             username_source, renamed, email, email_verified,
                             password_imported, disabled, note
--skip-unverified            leave out accounts that never confirmed their email
--link-existing-verified     map onto an auth account that already has the same
                             verified email instead of reporting a conflict
--send-reset-emails          afterwards, send a reset email to every account
                             created without a password (--reset-all: everyone)
--auth-url URL               for reset emails, e.g. https://auth.boson.chat
--reset-interval 7s          pause between reset emails (auth rate limit:
                             10/min per IP by default)
```

What it does with each account:

| Supabase account | Result |
|---|---|
| has a boson profile | username = its boson `handle`, made IRC-valid (`Bob.Smith` → `Bob_Smith`) |
| no profile | username from `raw_user_meta_data` (`handle`, `username`, `user_name`, `preferred_username`, `nickname`, `nick`, `name`, `full_name`), else the email's local part, made valid (`123go` → `u123go`, `NickServ` → `NickServ_`) |
| username taken (RFC 1459 casemapping) | numeric suffix: `bob` → `bob2`; flagged `renamed` |
| `email_confirmed_at` set | `email_verified_at` copied; otherwise imported unverified (they verify on first sign-in; "Resend email" in the app) |
| bcrypt `encrypted_password` | copied with `--passwords bcrypt`; upgraded to argon2id on first sign-in |
| no password (OAuth / magic link) | no credential; needs a reset email |
| `banned_until` in the future | imported disabled |
| `deleted_at` set / anonymous | skipped |
| no email, duplicate email in the export | conflict (reported, not imported) |
| email already on an auth account | conflict, or mapped with `--link-existing-verified` if that account's email is verified. An **unverified** match is always a conflict (could be someone squatting the address) |
| already in `auth_identities` | skipped: reruns are safe |

It also writes a `user_imported` row to the auth service's `audit_log` per
account. Exit status is non-zero if any account failed; `CONFLICT` lines are
printed for everything needing a human.

### The auth-service change for bcrypt passwords

Supabase stores bcrypt hashes; the auth service only verifies argon2id. Without
a change, an imported bcrypt hash makes that user's sign-in fail with a 500.
[`docs/auth-service-bcrypt-import.patch`](auth-service-bcrypt-import.patch)
(applies to boson-chat/auth `main`, `git apply`) teaches
`internal/password.Hasher.Verify` to check `$2a$`/`$2b$`/`$2y$` hashes with
`golang.org/x/crypto/bcrypt` and always report `needsRehash`. The existing
login path (`authn.checkPassword`) already replaces a hash that needs a
rehash, so the first successful sign-in (or SASL check) stores argon2id and
bcrypt is gone for that user. The patch adds unit tests
(`TestVerifyImportedBcrypt`) and an integration test
(`TestImportedBcryptPasswordUpgradesOnLogin`); both pass. No schema change,
and `password change` works on bcrypt hashes too.

Keeping passwords matters more than usual here: each user's identity key is
wrapped with their password. With the bcrypt path they sign in with their
old password and everything unlocks. With `--passwords none` everyone sets a
new password, and then needs their **recovery code** once to unlock their
identity key (the app offers it; it re-wraps under the new password).
Accounts without a recovery code would have to "Start fresh".

### Exporting from Supabase

With the database connection string from the Supabase dashboard (Project
Settings → Database), read-only:

```sh
psql "$SUPABASE_DB_URL" -c "\copy (SELECT id, email, encrypted_password, email_confirmed_at,
  raw_user_meta_data, created_at, banned_until, deleted_at, is_anonymous
  FROM auth.users) TO 'supabase-users.csv' CSV HEADER"
```

(Drop `banned_until`, `deleted_at` or `is_anonymous` if your Supabase
version lacks them; only `id` and `email` are required.) The file holds
password hashes: keep it off shared disks and delete it after
the cutover. (`auth.identities` holds OAuth links; nothing imports them — the
auth service has no OAuth yet, and the Boson app never offered it.)

## Cutover runbook

Order: **deploy auth → import users (dry run first) → deploy backend and
release the client together → decommission Supabase.**

### 0. Before the day

1. Merge [the bcrypt patch](auth-service-bcrypt-import.patch) into
   boson-chat/auth and release it. (Or decide on `--passwords none`; see
   above.)
2. Deploy the auth service at `https://auth.boson.chat`:
   `PUBLIC_URL=ISSUER=https://auth.boson.chat`, real SMTP, `REQUIRE_EMAIL_VERIFICATION=true`,
   `REGISTRATION=open`, its own `AUTH_KEY_ENCRYPTION_KEY`. `CORS_ALLOWED_ORIGINS`
   doesn't matter for the desktop app (it calls through its Go proxy). Check:
   `curl https://auth.boson.chat/readyz`, `/.well-known/jwks.json`, register a
   test account, verify, sign in.
3. Run boson's migration `000010` against production (`server migrate up`).
   It only adds `auth_identities`; the running (Supabase) backend ignores it.
4. Back up boson's Postgres and the (empty) auth database.
5. Build the client release from this branch (CI `desktop.yml` now bakes
   `VITE_AUTH_URL=https://auth.boson.chat`) but don't publish it yet.
6. Dry run: export Supabase users, then from somewhere that reaches both
   databases (e.g. a one-off pod with the backend image):
   ```sh
   server import-supabase-users --export supabase-users.csv \
     --auth-db "$AUTH_DATABASE_URL" --passwords bcrypt --dry-run --mapping-out dry-run.csv
   ```
   Review `dry-run.csv`: every `conflict`, every `renamed` username, every
   account without a password. Resolve conflicts (see "Decisions" below).

### 1. Cutover

1. Announce a short maintenance window. In Supabase, turn off new sign-ups
   (Authentication → Sign In / Providers → "Allow new users to sign up") so
   nobody registers after the export.
2. Take the final export and import for real:
   ```sh
   server import-supabase-users --export supabase-users.csv \
     --auth-db "$AUTH_DATABASE_URL" --passwords bcrypt --mapping-out import.csv
   ```
   Rerun it (same command) if anything was fixed in between: done accounts are
   skipped. Fallback without the bcrypt patch:
   `--passwords none --send-reset-emails --auth-url https://auth.boson.chat`.
   With bcrypt, accounts that had no password (OAuth / magic link, if any) are
   still created without one: add `--send-reset-emails --auth-url …` to the
   same run to mail them.
3. Spot-check: sign in as a known imported account against
   `https://auth.boson.chat`, call `GET https://api.boson.chat/me` with the
   token after the next step — it must return the old profile.
4. Deploy the backend from this branch with `AUTH_JWKS_URL=https://auth.boson.chat/.well-known/jwks.json`,
   `AUTH_ISSUER=https://auth.boson.chat`, `AUTH_AUDIENCE=boson`, and
   `SUPABASE_JWKS_URL` removed.
5. Publish the client release (tag → `desktop.yml` builds; the in-app updater
   picks it up). Old clients now get 401 from the API; users update and sign
   in again.
6. Watch: backend 401/500 rates, auth `auth_login_attempts_total` by outcome,
   `auth_registrations_total`, `auth_emails_sent_total`.

### 2. After

1. Keep the Supabase project (paused) for a few weeks as the rollback path
   and audit trail, then delete it, and delete the export files.
2. GitHub secrets `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are no longer
   read by any workflow: delete them after decommissioning.
3. Add the `AUTH_REPO_TOKEN` secret (read access to boson-chat/auth) so the e2e
   workflow can build the auth service.
4. Remove the Supabase project's redirect / email template config; the
   website's `/auth/confirmed` page now only tells people with old links to
   update. `emails/` is kept only as the design reference for the auth
   service's own templates.

## Rollback

**Before the client release** (backend deployed, client not published):
redeploy the previous backend image with `SUPABASE_JWKS_URL` back. Imported
accounts' boson data was never modified, so nothing else is needed; the
`auth_identities` table and the auth service's users can stay (or
`server migrate down` one step to drop the table). Re-enable Supabase
sign-ups.

**After the client release**: publish the previous client version again (a
new tag with the old code, so the updater offers it) and redeploy the
previous backend. Caveats:

- Accounts **created on the auth service** after the cutover don't exist in
  Supabase; their boson data (UUIDv5 ids) is orphaned until you roll forward
  again.
- Password changes / resets made on the auth service don't flow back to
  Supabase; those users sign in with their old Supabase password, and their
  identity key was possibly re-wrapped under the new one (they'd need their
  recovery code).

Rolling forward again later is just rerunning the import (idempotent) and
redeploying.

## Decisions for the owner

- **Username collisions**: the tool appends a number (`bob2`) and flags it.
  Alternatives: let users pick on first sign-in (needs an auth-service
  "rename" endpoint, which doesn't exist yet), or hand-edit before import.
- **Handles that aren't IRC-valid** (dots, spaces, leading digits) are
  rewritten (`Bob.Smith` → `Bob_Smith`). The boson handle itself (users.handle)
  is unchanged; only the account username differs.
- **Unverified accounts**: imported unverified by default (they can verify
  and sign in later). `--skip-unverified` drops them instead.
- **Accounts without a password** (OAuth / magic link, if any existed): no
  OAuth in the auth service yet (phase 2), so they get a reset email.
- **Email already registered on the auth service**: conflict by default;
  `--link-existing-verified` to merge when that email is verified there.
- **Semantic version**: these commits are `feat:` (minor bump). The hard
  cutover breaks old clients; mark it `BREAKING CHANGE` when merging if you
  want 1.0.0.
- **E2E in CI** needs the private auth repo: the workflow checks it out with
  `AUTH_REPO_TOKEN`. Fork PRs can't see secrets, so account specs can't run
  there (alternatively, publish an auth image the workflow can pull and set
  `AUTH_IMAGE`).
