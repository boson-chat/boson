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
- **The backend DB, the auth service and the network directory are shared
  and long-lived** (until `make test-e2e-app-down`). Seeded servers stay
  listed in everyone's directory. The directory lists each hostname once, so
  `seedServer()` registers the ergo under a unique `*.localhost` name
  (`seededHostname()`; `*.localhost` resolves to loopback), and guest specs
  add it by hand as `127.0.0.1` (`IRC_HOST`). Search the directory for your
  server's unique name rather than counting cards.
- The catch-all Mailpit is drained by the backend's nick-claim worker every
  5s (it deletes what it can't route). It relays a copy of every message to
  `mailpit-archive` (`STACK.catchallMail.archiveApiUrl`), which nothing
  drains: read NickServ codes from that (`Mailpit.catchallCopy()`).

## Fixtures

| Fixture | Value |
| --- | --- |
| `launchApp(opts?)` | Launches the app → `{ app, page, openedExternally() }`. Call again (same `profile`) to relaunch. Closed + cleaned up after the test. |
| `profile` | The test's throwaway HOME / runtime / userData dirs. |
| `zncUser` | `{ host, port, username, password, network }` — a ZNC user leased for this test and reset (upstream disconnected, no channels). |
| `account` | A verified auth-service user **with** a Boson identity (handle + password-wrapped secret + recovery code): `{ id, bosonId, username, email, password, handle, recoveryCode }`. `id` is the auth user id (`usr_…`, what the app keys the keychain on); `bosonId` the backend's `users.id`. `loginAs(page, account)` lands in the directory. |
| `createAccount(opts?)` | Factory: `{ email?, password?, handle?: boolean \| string }`. Without `handle` the user is verified but has no `/me` yet — the first sign-in shows the handle setup. All created users are disabled after the test (the auth service has no delete). |
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

Backend + data (`helpers/backend.ts`, `helpers/auth.ts`):

| Helper | Does |
| --- | --- |
| `seedServer(input?)` | Registers a listing on the e2e network directory (`POST /v1/networks`, as a per-process operator account) and verifies it (fake DNS) so it's listed. Defaults: the e2e ergo on port 16667 under a unique `*.localhost` hostname, plain TCP, unique name. → `DirectoryServer`. |
| `directoryApi(token?)` / `directoryApiAs(user)` | A `BackendApi` for the directory's `/v1` API (`STACK.directory.url`), signed in as `user` for owner calls (`/v1/me/networks`, verify, PATCH, images). |
| `directorySql(sql)` | psql against the directory's Postgres (`networks`): state only its disabled workers set (health, user counts, lapses, token age). |
| `provisionIdentity(user, handle?)` | `POST /me` with a real secret wrapped under the user's password + a recovery code (the app's own crypto). → `{ handle, recoveryCode }`. |
| `BackendApi.as(user)` / `.anonymous()` | `get/post/put/patch/delete` (throw on non-2xx), `request` (returns `{ status, ok, body }`). |
| `backendSql(sql)` | psql against the backend's Postgres (unaligned, tuples-only output). Prefer the API. |
| `createConfirmedUser(opts?)`, `deleteAuthUser(id)`, `findAuthUserByEmail(email)`, `setAuthPassword(id, pw)`, `signInWithPassword(login, password)`, `verifyEmail(email)`, `emailToken(email, page)`, `bosonUserId(id)` | The auth service's API, its admin API (as the stack's `e2eadmin`) and the users' Mailpit. `setAuthPassword` runs a real forgot → reset (which signs out every session). |
| `randomEmail()`, `randomPassword()`, `randomUsername()`, `randomHandle()`, `randomChannel()`, `randomNick()`, `uid()` | Unique names. |

Files (`helpers/files-server.ts`): `startFakeFiles(opts?)` — a fake
boson-chat/files host on a random loopback port (config, usage, guest
tokens, uploads, `/f/` with expiry); `filesNetworkJson(irc, authUrl, filesUrl)`
— a `BOSON_NETWORK_JSON` naming it for one IRC host.

Mail (`helpers/mailpit.ts`): `Mailpit.users()` / `Mailpit.catchall()` /
`Mailpit.catchallCopy()` with
`list(query?)`, `read(id)`, `waitFor({ to?, subject?, timeoutMs? })`,
`clear(query?)`; `extractLinks(msg)`, `extractCode(msg, re?)`.

IRC: `IrcPeer` (`irc-peer.ts`) — a raw IRC client to be the other side of
a conversation (`connect`, `join`, `privmsg`, `mark`, `waitFor`,
`waitForJoin`, `waitForPrivmsg`, `quit`); with `pass` it talks to ZNC.
ZNC: `leaseZncUser()` / `resetZncUser()` if a test needs more than one.

IRC services (`helpers/services.ts`, imported directly): ergo's NickServ
mails verification codes to the catch-all — `verificationCode(email)` reads
one from its undrained copy; `registerPeerAccount(peer, pw)` /
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
two layers (renderer, the Go app + engine); see the repo README.
New specs are measured automatically.

## Web target (E2E_TARGET=web)

The same specs drive the web build (chat.boson.chat: `platform/web`, the
engine as WebAssembly) in Chromium, Firefox and WebKit — the launcher, not
copies (`target.ts`, `web-app.ts`, `web-server.ts`):

```sh
node scripts/e2e-stack.mjs up          # the stack (as for the desktop target)
node scripts/e2e-gateway.mjs up        # the IRC gateway (the stack's webircgateway, built natively)
npm run build:e2e-web                  # out-e2e/web
npm run test:e2e:web -- --project=web-firefox --project=web-firefox-mobile
```

- The page is served on `stack.json` `web.url` (127.0.0.1:18800), the
  origin the e2e services' CORS allows; each test gets its own browser
  profile. It reaches IRC through the gateway (`web.gateway.url`), which
  here may dial loopback and any port ≥ 1024 (production: IRC ports and
  public addresses only).
- The desktop's test environment reaches the page as
  `window.bosonWebE2EEnv` (BOSON_NETWORK_JSON documents, the API outage
  switch); `bosonE2E` has the hooks the web can do (engine crash, API
  outage, opened links, a link arriving while open).
- Target-specific checks use `IS_WEB` (the title bar, About's Platform row,
  where secrets and themes are stored: `secureStoreOnDisk()`), and
  `webSkip(reason)` marks what only the native app has. Skipped on the web:

| Spec | Why |
|---|---|
| app-shell: About update states | no in-app updater (each deploy is the latest) |
| app-shell: secure store file ×2 | the desktop store file format; the web store is unit-tested (`platform/web/secure-store.test.ts`) |
| app-shell: API proxy | the desktop's API proxy; the web calls services directly under CORS |
| app-shell: Spotify | the desktop's Spotify fetcher (no cards on the web) |
| chat-embeds: website card, YouTube wrapper ×3 | the desktop's unfurl fetcher and YouTube wrapper page |
| image-cache (file) | the desktop's image disk cache |
| security: navigation guard | belongs to the desktop window; a web page may navigate |
| themes: theme file + live edit | the desktop's themes folder and watcher |
| mobile-layout (swipe), mobile-load-older ×3, mobile-channel-reorder — Firefox and WebKit only | touch gestures are sent through Chromium's DevTools protocol, which Playwright has only in Chromium (they run in web-chromium-mobile) |
| web-calls — Linux WebKit only | WebKitGTK has no WebTransport (the app is chat-only there and says so) |

Known gaps, marked `webBrowserFixme` (not run, reported as fixme; to fix):

| Spec | Browser | What |
|---|---|---|
| channel-reorder | WebKit | the pointer drag doesn't reorder |
| chat-scroll: scroll up and back down, bouncer-backlog: scroll-up | WebKit, Firefox | older history pages in only once while scrolling up |
| web-calls | Firefox on Linux CI | the call never joins headless (passes on macOS) |
| mobile-layout: relaunch, mobile-network ×3 | WebKit (phone) | the add-server sheet never settles under phone emulation |
