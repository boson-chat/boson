# Integration tests

This directory contains bloc + view round-trip tests for the boson renderer.
Each test mounts the **real** screen component (e.g. `LoginScreen`,
`DirectoryScreen`, `ChatLayout`) — which builds its own `LoginBloc` /
`DirectoryBloc` / `ChatInputBloc` / `ChatLayoutBloc` via `useMemo` — and
exercises it through user interactions from `@testing-library/user-event`.

Only the *boundary* is faked:

- `fetch` is replaced with a route table via `mockFetch()` (see `helpers.tsx`).
  Routes are keyed `"<METHOD> <pathname>"`, e.g. `'GET /servers'`.
- `WebSocket` is replaced with `FakeWebSocket`, exposed via the
  `wsCtor` option on the real `EngineClient`. Drive it from tests with
  `ws._open()`, `ws._receive(json)`, `ws._close()`.
- `AuthService` is replaced with `FakeAuthService` — Supabase's `createClient`
  is the only thing we can't reach over `fetch` alone, and the structural
  interface is small (`signIn`, `signUp`, `signOut`, `getToken`, `subscribe`,
  `getState`). Use `auth._setSession(...)` to drive a "signed-in" state.

The real `LoginBloc`, `DirectoryBloc`, `ChatInputBloc`, `ChatLayoutBloc`,
`ChatService`, `EngineClient`, `IdentityService`, `DirectoryService`, and
`HttpClient` are all in the loop.

## Conventions

- File suffix: `*.int.test.tsx`. The Vitest include pattern picks them up.
- Helpers live in `helpers.tsx`. Prefer adding to it over re-defining a
  fixture in a single test file.
- Identity uses a no-op KDF (see `makeIdentity()`) so Argon2id doesn't add
  ~200ms per call — encryption / decryption is still real Web Crypto.
- Keep each test under ~1s. The whole file should be done in a few seconds.

## When to use vs. unit tests

Use these integration tests when a behaviour spans **multiple blocs** or a
**bloc + view + service**. For single-bloc state-machine logic, prefer the
existing unit tests next to each bloc (`*.test.ts`).
