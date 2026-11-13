// Deep-link bridge for the renderer. The desktop shell (desktop/deeplink.go)
// catches boson:// URLs (open-URL on macOS, argv on Win/Linux, second-
// instance forwarding when the app is already running) and forwards
// them here via the bosonDeepLink bridge.
//
// One verb is recognised today:
//
//   - boson://join?host=…&port=…&tls=1[&name=…]
//       Fired by the marketing site's /discover page when a user clicks
//       "Open in Boson" on a directory card. Triggers the same code
//       path as adding a server manually in Advanced mode.
//
// (boson://auth/confirmed, which carried Supabase session tokens after an
// email confirmation, is gone: the auth service's verification link opens
// its own page and the user then signs in. Such links are now ignored, so
// no web page can push a session into the app.)
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

// Module-level queue: if a deep link arrives before any subscriber is
// attached (typical when the renderer is still on the loading screen
// and the user clicks a boson:// link), we buffer it here. The queue
// keeps only the most recent URL — back-to-back deep-links resolve to the
// latest user intent.
let pendingJoinUrl: string | null = null;
const joinListeners = new Set<(params: JoinParams) => void>();

// Dedupe state — on cold start the same URL can arrive via both the
// `bridge.consume()` drain AND the live `bridge.onJoin` send (main
// fires both paths to maximise the chance of reaching the renderer).
// Without this guard the user would get two join attempts for one
// click. A short time window prevents legitimate re-clicks of the
// same link from being silently ignored.
const DEDUPE_WINDOW_MS = 1500;
let lastDeliveredUrl: string | null = null;
let lastDeliveredAt = 0;

function deliver(url: string): void {
  if (url === lastDeliveredUrl && Date.now() - lastDeliveredAt < DEDUPE_WINDOW_MS) {
    return;
  }
  lastDeliveredUrl = url;
  lastDeliveredAt = Date.now();
  deliverInner(url);
}

function deliverInner(url: string): void {
  // Strip anything token-like from logs but keep enough to see WHICH
  // verb fired + whether parsing succeeded.
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
 * Wire the renderer to the shell-installed `window.bosonDeepLink`
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
  joinListeners.clear();
  lastDeliveredUrl = null;
  lastDeliveredAt = 0;
}
