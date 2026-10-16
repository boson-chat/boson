# Real-app e2e: fixtures and helpers

Specs here drive the built desktop app (a server-mode build of `desktop/`,
in Chromium; see `desktop-app.ts`) against the e2e stack (endpoints:
`infra/e2e/stack.json`; how to run it: the repo README, "End-to-end tests
(real app)"). Import everything from `./fixtures`:

```ts
import { test, expect, loginAs, seedServer, randomChannel } from './fixtures';
```

## Rules for new specs

- **Assume parallel.** Tests run fully parallel (4 workers locally) and
  other people's runs may share the stack. Never reuse a fixed channel,
  nick, email, handle or server name — use `randomChannel()`,
  `randomNick()`, `randomEmail()`, `randomHandle()`, `uid()`. Use the
  `zncUser` fixture for anything ZNC; never hard-code a ZNC user.
- **The backend DB and Supabase are shared and long-lived** (until
  `make test-e2e-app-down`). Seeded servers stay listed in everyone's
  directory. The app hides a manually added server when the directory lists
  the same `hostname:port`, so `seedServer()` registers the ergo as
  `localhost` and guest specs add it by hand as `127.0.0.1` (`IRC_HOST`).
  Search the directory for your server's unique name rather than counting
  cards.
- The catch-all Mailpit is drained by the backend's nick-claim worker every
  5s (it deletes what it can't route): read from it promptly.

## Fixtures

| Fixture | Value |
| --- | --- |
| `launchApp(opts?)` | Launches the app → `{ app, page, openedExternally() }`. Call again (same `profile`) to relaunch. Closed + cleaned up after the test. |
| `profile` | The test's throwaway HOME / runtime / userData dirs. |
| `zncUser` | `{ host, port, username, password, network }` — a ZNC user leased for this test and reset (upstream disconnected, no channels). |
| `account` | A confirmed Supabase user **with** a Boson identity (handle + password-wrapped secret + recovery code): `{ id, email, password, handle, recoveryCode }`. `loginAs(page, account)` lands in the directory. |
| `createAccount(opts?)` | Factory: `{ email?, password?, handle?: boolean \| string }`. Without `handle` the user is confirmed but has no `/me` yet — the first sign-in shows the handle setup. All created users are deleted after the test. |
| `backendApi(user?)` | `BackendApi` for `STACK.backend.url` — anonymous, or signed in as `user` (`{ email, password }`). |
| `mailpit` | `{ users, catchall }`: `Mailpit` clients for the auth inbox and the boson.chat catch-all. |

Account fixtures fail fast with instructions when the stack isn't up.

## Helpers

UI flows (`helpers/account.ts`):

| Helper | Does |
| --- | --- |
| `signUpViaUi(page, { email, password })` | Signup tab → submit → waits for "Check your email." |
| `confirmSignup(app, email)` | Confirmation mail → GoTrue `/verify` → the `boson://auth/confirmed?…` URL the website would hand the OS → delivered to the app. The app then has a session but a locked identity: continue with `loginAs`. |
| `confirmationDeepLink(email)` | Just the `boson://auth/confirmed?…` URL (to tamper with / replay). |
| `deliverDeepLink(app, url)` | Any `boson://` URL, as the OS would (`open-url` on macOS, second-instance argv elsewhere). |
| `loginAs(page, { email, password })` | Login tab → Sign in (unlocks the identity with the password) → `'setup' \| 'directory'`. Throws with the on-screen error if sign-in fails. |
| `submitLogin(page, { email, password })` | Just fills + submits the login form, for specs expecting a failure. |
| `completeHandleSetup(page, handle)` | First-sign-in handle prompt → acknowledges the recovery code → directory. Returns the recovery code. |
| `recoverWithCode(page, code)` | The recovery-code unlock offered when the password no longer decrypts the identity (e.g. after a password reset). |
| `signOut(page)` | Directory top bar → Sign out → login screen. |
| `continueAsGuest(page, nick)`, `addServerManually`, `serverCard`, `joinChannel`, `composer`, `sendMessage`, `memberList`, `messageList`, `configureBouncerProfile`, `field` | Guest / chat UI (see `fixtures.ts`). |

Backend + data (`helpers/backend.ts`, `helpers/supabase.ts`):

| Helper | Does |
| --- | --- |
| `seedServer(input?)` | Registers a server through `POST /servers` and verifies it (dev DNS bypass) so it's listed. Defaults: the e2e ergo as `localhost:16667`, plain TCP, unique name. → `DirectoryServer`. |
| `provisionIdentity(user, handle?)` | `POST /me` with a real secret wrapped under the user's password + a recovery code (the app's own crypto). → `{ handle, recoveryCode }`. |
| `BackendApi.as(user)` / `.anonymous()` | `get/post/put/patch/delete` (throw on non-2xx), `request` (returns `{ status, ok, body }`). |
| `backendSql(sql)` | psql against the backend's Postgres (unaligned, tuples-only output). Prefer the API. |
| `createConfirmedUser(opts?)`, `deleteAuthUser(id)`, `findAuthUserByEmail(email)`, `setAuthPassword(id, pw)`, `signInWithPassword(email, password)` | Supabase admin / auth API (`setAuthPassword` = the outcome of a password reset). |
| `randomEmail()`, `randomPassword()`, `randomHandle()`, `randomChannel()`, `randomNick()`, `uid()` | Unique names. |

Mail (`helpers/mailpit.ts`): `Mailpit.users()` / `Mailpit.catchall()` with
`list(query?)`, `read(id)`, `waitFor({ to?, subject?, timeoutMs? })`,
`clear(query?)`; `extractLinks(msg)`, `extractCode(msg, re?)`.

IRC: `IrcPeer` (`irc-peer.ts`) — a raw IRC client to be the other side of
a conversation (`connect`, `join`, `privmsg`, `mark`, `waitFor`,
`waitForJoin`, `waitForPrivmsg`, `quit`); with `pass` it talks to ZNC.
ZNC: `leaseZncUser()` / `resetZncUser()` if a test needs more than one.

IRC services (`helpers/services.ts`, imported directly): ergo's NickServ
mails verification codes to the catch-all — `verificationCode(email)` reads
one before the POP3 worker drains it; `registerPeerAccount(peer, pw)` /
`preregisterAccount(nick, pw)` make verified accounts; `whoisAccount` /
`expectWhoisAccount` / `nickServInfo` check the IRC side;
`openServerSettings(page, section)`, `servicesBadge`, `accountBadge` for the
Identity panel. The e2e ergo has no MemoServ, no ChanServ channel
registration and no GHOST (and refuses `*Serv` nicks), so `MemoNet` is a
tiny in-process IRC server with Anope-style NickServ VERSION + MemoServ
(LIST / READ / DEL) for the memo flows.

Endpoints and paths: `STACK` / `APP_DIR` (`stack.ts`), `IRC_HOST` /
`IRC_PORT` / `ZNC_HOST` / `ZNC_PORT`.

## Coverage

`make test-e2e-app-coverage` writes `client/coverage/e2e/summary.md` with
four layers (renderer, main + preload, engine, backend); see the repo README.
New specs are measured automatically.
