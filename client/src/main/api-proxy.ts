// Proxies the renderer's API requests through the main process so they aren't
// subject to browser CORS. This lets the renderer run on a loopback http origin
// (needed for origin-sensitive embeds) while still reaching api.boson.chat,
// whose CORS policy doesn't allow that origin. Node's fetch has no CORS notion.
import { isBlockedHost } from './og-parse';

export interface ApiProxyRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | null;
}

export interface ApiProxyResponse {
  status: number;
  ok: boolean;
  statusText: string;
  text: string;
}

const FETCH_TIMEOUT_MS = 30_000;

function fail(statusText: string): ApiProxyResponse {
  return { status: 0, ok: false, statusText, text: '' };
}

// Allow public https hosts (our API) and loopback (a local dev backend), but
// block other private/link-local ranges so a compromised renderer can't use the
// proxy to reach the user's LAN / cloud-metadata endpoints.
function allowed(u: URL): boolean {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (u.protocol !== 'https:') return false;
  return !isBlockedHost(h);
}

export async function proxyApiFetch(req: ApiProxyRequest): Promise<ApiProxyResponse> {
  if (!req || typeof req.url !== 'string' || typeof req.method !== 'string') return fail('Bad request');
  let u: URL;
  try { u = new URL(req.url); } catch { return fail('Bad URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('Bad scheme');
  if (!allowed(u)) return fail('Blocked host');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const body = req.body == null
      ? undefined
      : (typeof req.body === 'string' ? req.body : Buffer.from(req.body));
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers ?? {},
      body,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, statusText: res.statusText, text };
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'fetch failed');
  } finally {
    clearTimeout(timer);
  }
}
