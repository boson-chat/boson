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

    // Follow redirects MANUALLY so allowed() runs on every hop. With
    // redirect:'follow' the guard only checks the initial URL — a public
    // https host could then 302 us to http://169.254.169.254/ or a LAN
    // address and the proxy would happily fetch it, defeating the SSRF
    // blocklist this function exists to enforce.
    const MAX_REDIRECTS = 5;
    let currentUrl = u.toString();
    let currentOrigin = u.origin;
    let method = req.method;
    let sendBody = body;
    let headers: Record<string, string> = { ...(req.headers ?? {}) };

    for (let hop = 0; ; hop++) {
      const res = await fetch(currentUrl, {
        method,
        headers,
        body: sendBody,
        signal: ctrl.signal,
        redirect: 'manual',
      });

      if (res.status >= 300 && res.status < 400) {
        if (hop >= MAX_REDIRECTS) return fail('Too many redirects');
        const loc = res.headers.get('location');
        if (!loc) return fail('Redirect without location');
        let next: URL;
        try { next = new URL(loc, currentUrl); } catch { return fail('Bad redirect URL'); }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return fail('Bad redirect scheme');
        if (!allowed(next)) return fail('Blocked redirect host');

        // Cross-origin hop: drop credential-bearing headers so a redirect to
        // a third-party host can't harvest the Authorization/Cookie the
        // renderer set for our own API (mirrors the fetch spec's stripping).
        if (next.origin !== currentOrigin) {
          const stripped: Record<string, string> = {};
          for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (lk === 'authorization' || lk === 'cookie') continue;
            stripped[k] = v;
          }
          headers = stripped;
        }
        // 303 (and a non-GET/HEAD 301/302) becomes a bodyless GET.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          sendBody = undefined;
        }
        currentUrl = next.toString();
        currentOrigin = next.origin;
        continue;
      }

      const text = await res.text();
      return { status: res.status, ok: res.ok, statusText: res.statusText, text };
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'fetch failed');
  } finally {
    clearTimeout(timer);
  }
}
