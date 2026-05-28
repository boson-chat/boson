// Deep-link bridge for the renderer. The Electron main process catches
// boson:// URLs (from open-url on macOS, argv on Win/Linux, second-
// instance forwarding when the app is already running) and forwards
// them here via the preload bridge.
//
// Two verbs are recognised today:
//
//   - boson://join?host=…&port=…&tls=1[&name=…]
//       Fired by the marketing site's /discover page when a user clicks
//       "Open in Boson" on a directory card. Triggers the same code
//       path as adding a server manually in Advanced mode.
//
//   - boson://auth/confirmed#access_token=…&refresh_token=…&type=signup
//       Fired by the website's /auth/confirmed page after Supabase
//       email-confirms a new signup. Carries the tokens that the
//       desktop AuthService needs to hydrate a session for the user
//       who just confirmed.
//
// Parsing happens in the renderer so the URL schema can evolve without
// crossing the IPC boundary. The bloc / app shell subscribes via the
// `subscribeDeepLink*` family and reacts to the typed parameter objects.

export interface JoinParams {
  host: string;
  port: number;
  tls: boolean;
  name?: string;
}

// Tokens carried in the URL fragment (implicit flow) or query (PKCE).
// We accept either shape so we don't have to know which flowType the
// AuthService picked. The desktop AuthService.setSessionFromTokens
// handles the actual hydration.
export interface AuthConfirmedParams {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  // `code` is the PKCE flow's exchange code. Mutually exclusive with
  // accessToken/refreshToken — if both are present, the AuthService
  // prefers the PKCE exchange path.
  code?: string;
  // `type` is Supabase's hint about which flow produced this redirect:
  // "signup" / "recovery" / "magiclink" / "invite" / "email_change".
  // The app uses it to pick the right post-auth landing screen.
  type?: string;
}

interface DeepLinkBridge {
  consume(): Promise<string | null>;
  onJoin(fn: (url: string) => void): () => void;
}

/**
 * Parse a `boson://join?…` URL into typed JoinParams, or null when the
 * URL is malformed or for a different verb. Accepted query params:
 * host (required), port (default 6697), tls (default true; "0" / "false"
 * disables), name (optional display label).
 */
export function parseJoinUrl(url: string): JoinParams | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'boson:') return null;
  if (parsed.host !== 'join') return null;

  const host = parsed.searchParams.get('host')?.trim() ?? '';
  if (!host) return null;

  const portStr = parsed.searchParams.get('port') ?? '6697';
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

  const tlsRaw = parsed.searchParams.get('tls');
  const tls = tlsRaw == null
    ? true
    : !['0', 'false', 'no'].includes(tlsRaw.trim().toLowerCase());

  const name = parsed.searchParams.get('name')?.trim() || undefined;
  return { host, port, tls, name };
}

/**
 * Parse `boson://auth/confirmed?...` (PKCE) or
 * `boson://auth/confirmed#access_token=...` (implicit) into typed
 * AuthConfirmedParams. Returns null when no recognised auth params are
 * present (e.g. a stray boson://auth/confirmed with no hash).
 *
 * Supabase emits the fragment form when its auth client is in implicit
 * mode (the default for v2 in browser environments). The PKCE case
 * shows up here because the website's /auth/confirmed page forwards
 * the entire URL search + hash on to us — supporting both keeps the
 * desktop app forward-compatible if we ever flip flowType.
 */
export function parseAuthConfirmedUrl(url: string): AuthConfirmedParams | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'boson:') return null;
  // The verb is `auth` and the pathname is `/confirmed` — URL parses
  // boson://auth/confirmed as host=auth, pathname=/confirmed.
  if (parsed.host !== 'auth') return null;
  if (parsed.pathname !== '/confirmed') return null;

  // Implicit-flow tokens live in the URL fragment as &-separated
  // key=value pairs (Supabase emits exactly that shape).
  const fromHash = parseFragmentParams(parsed.hash);
  // PKCE-flow code lives in the query string.
  const fromQuery = parsed.searchParams;

  const params: AuthConfirmedParams = {
    accessToken: fromHash.get('access_token') ?? undefined,
    refreshToken: fromHash.get('refresh_token') ?? undefined,
    tokenType: fromHash.get('token_type') ?? undefined,
    type: fromHash.get('type') ?? fromQuery.get('type') ?? undefined,
    code: fromQuery.get('code') ?? undefined,
  };
  const expiresIn = fromHash.get('expires_in');
  if (expiresIn) {
    const n = Number.parseInt(expiresIn, 10);
    if (Number.isFinite(n)) params.expiresIn = n;
  }

  // Reject the no-tokens-no-code case so the auth handler doesn't have
  // to repeat the check.
  if (!params.accessToken && !params.code) return null;
  return params;
}

function parseFragmentParams(hash: string): URLSearchParams {
  // location.hash includes the leading '#', URLSearchParams expects
  // no prefix.
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  return new URLSearchParams(trimmed);
}

// Module-level queue: if a deep link arrives before any subscriber is
// attached (typical when the renderer is still on the loading screen
// and the user clicks a boson:// link), we buffer it here. Both queues
// keep only the most recent URL — back-to-back deep-links of the same
// kind resolve to the latest user intent.
let pendingJoinUrl: string | null = null;
let pendingAuthUrl: string | null = null;
const joinListeners = new Set<(params: JoinParams) => void>();
const authListeners = new Set<(params: AuthConfirmedParams) => void>();

function deliver(url: string): void {
  // Strip the access_token from logs but keep enough to see WHICH
  // verb fired + whether parsing succeeded. Helpful when users report
  // "the deep-link didn't sign me in" — we can ask them to check
  // DevTools console and see exactly where the chain broke.
  const safeUrl = url.replace(/(access_token|refresh_token)=([^&]+)/g, '$1=<redacted>');
  console.info('[deep-link] received', safeUrl);

  const join = parseJoinUrl(url);
  if (join) {
    console.info('[deep-link] parsed as join', { host: join.host, port: join.port });
    if (joinListeners.size === 0) {
      console.info('[deep-link] buffering join (no listener yet)');
      pendingJoinUrl = url;
      return;
    }
    for (const fn of joinListeners) fn(join);
    return;
  }
  const auth = parseAuthConfirmedUrl(url);
  if (auth) {
    console.info('[deep-link] parsed as auth/confirmed', {
      hasAccessToken: !!auth.accessToken,
      hasCode: !!auth.code,
      type: auth.type,
    });
    if (authListeners.size === 0) {
      console.info('[deep-link] buffering auth (no listener yet)');
      pendingAuthUrl = url;
      return;
    }
    for (const fn of authListeners) fn(auth);
    return;
  }
  console.warn('[deep-link] no parser matched', safeUrl);
}

/**
 * Subscribe to deep-link join events. Returns an unsubscribe function.
 * If a deep-link is already buffered when this is called (cold-start
 * or arrived-before-mount), the subscriber is invoked synchronously
 * with the buffered params before the function returns.
 */
export function subscribeDeepLink(fn: (params: JoinParams) => void): () => void {
  joinListeners.add(fn);
  if (pendingJoinUrl) {
    const url = pendingJoinUrl;
    pendingJoinUrl = null;
    const params = parseJoinUrl(url);
    if (params) fn(params);
  }
  return () => {
    joinListeners.delete(fn);
  };
}

/**
 * Subscribe to auth-confirmation deep-link events. Same buffering +
 * drain semantics as subscribeDeepLink, but for boson://auth/confirmed.
 */
export function subscribeAuthConfirmed(fn: (params: AuthConfirmedParams) => void): () => void {
  authListeners.add(fn);
  if (pendingAuthUrl) {
    const url = pendingAuthUrl;
    pendingAuthUrl = null;
    const params = parseAuthConfirmedUrl(url);
    if (params) fn(params);
  }
  return () => {
    authListeners.delete(fn);
  };
}

/**
 * Wire the renderer to the preload-exposed `window.bosonDeepLink`
 * bridge. Idempotent — safe to call on every boot. No-op when the
 * bridge isn't present (running in a browser tab via vite dev / e2e).
 */
export function initDeepLinkBridge(): void {
  const bridge = (window as unknown as { bosonDeepLink?: DeepLinkBridge }).bosonDeepLink;
  if (!bridge) return;
  void bridge.consume().then((url) => {
    if (url) deliver(url);
  });
  bridge.onJoin((url) => deliver(url));
}

// Test-only: clear queues + subscribers so each test starts clean.
export function __resetDeepLinkForTests(): void {
  pendingJoinUrl = null;
  pendingAuthUrl = null;
  joinListeners.clear();
  authListeners.clear();
}
