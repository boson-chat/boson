// Deep-link bridge for the renderer. The Electron main process catches
// `boson://join?host=…&port=…&tls=1` URLs (from open-url on macOS,
// argv on Win/Linux, second-instance forwarding when the app is
// already running) and forwards them here via the preload bridge.
//
// We parse here rather than in main so the URL schema can evolve
// without crossing the IPC boundary. The bloc subscribes via
// subscribeDeepLink() and reacts to JoinParams events.

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
 * URL is malformed or for a verb we don't recognise. Accepted query
 * params: host (required), port (default 6697), tls (default true; "0"
 * / "false" disables), name (optional display label).
 */
export function parseJoinUrl(url: string): JoinParams | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'boson:') return null;
  // boson://join?... — the verb sits in the URL "host" slot.
  if (parsed.host !== 'join') return null;

  const host = parsed.searchParams.get('host')?.trim() ?? '';
  if (!host) return null;

  const portStr = parsed.searchParams.get('port') ?? '6697';
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

  // tls defaults to true (the safer assumption); "0" / "false" /
  // "no" all disable. Anything else is treated as truthy.
  const tlsRaw = parsed.searchParams.get('tls');
  const tls = tlsRaw == null
    ? true
    : !['0', 'false', 'no'].includes(tlsRaw.trim().toLowerCase());

  const name = parsed.searchParams.get('name')?.trim() || undefined;
  return { host, port, tls, name };
}

// Module-level queue: if a deep link arrives before any subscriber is
// attached (typical when the renderer is still on the auth screen and
// the user clicks a boson:// link), we buffer it here and deliver on
// the next subscribe(). Only the most recent URL is kept — back-to-
// back deep-links resolve to the latest user intent.
let pendingUrl: string | null = null;
const listeners = new Set<(params: JoinParams) => void>();

function deliver(url: string): void {
  const params = parseJoinUrl(url);
  if (!params) return;
  if (listeners.size === 0) {
    pendingUrl = url;
    return;
  }
  for (const fn of listeners) fn(params);
}

/**
 * Subscribe to deep-link join events. Returns an unsubscribe function.
 * If a deep-link is already buffered when this is called (cold-start
 * or arrived-before-mount), the subscriber is invoked synchronously
 * with the buffered params before the function returns.
 */
export function subscribeDeepLink(fn: (params: JoinParams) => void): () => void {
  listeners.add(fn);
  if (pendingUrl) {
    const url = pendingUrl;
    pendingUrl = null;
    const params = parseJoinUrl(url);
    if (params) fn(params);
  }
  return () => {
    listeners.delete(fn);
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
  // Drain anything the main process captured before we attached the
  // listener (cold start from a browser click).
  void bridge.consume().then((url) => {
    if (url) deliver(url);
  });
  bridge.onJoin((url) => deliver(url));
}

// Test-only: clear queue + subscribers so each test starts clean.
export function __resetDeepLinkForTests(): void {
  pendingUrl = null;
  listeners.clear();
}
