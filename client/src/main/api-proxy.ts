// Proxies the renderer's API requests through the main process so they aren't
// subject to browser CORS. This lets the renderer run on a loopback http origin
// (needed for origin-sensitive embeds) while still reaching api.boson.chat,
// whose CORS policy doesn't allow that origin. Node's fetch has no CORS notion.
//
// Because main isn't subject to CORS (or the renderer's CSP), this bridge is
// a powerful primitive: anything that can call it can make credentialed
// requests from the user's machine. So it only talks to an exact-origin
// allowlist — our own API — rather than "any public https host".

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

// Production API, used when VITE_BOSON_API_URL wasn't baked into the build.
export const DEFAULT_API_BASE = 'https://api.boson.chat';

// Which origins the proxy may reach. Built once in main from build-time config.
//   - origins: exact origins (scheme + host + port), e.g. the configured API
//     base. Supabase isn't listed: supabase-js talks to Supabase directly from
//     the renderer (its CORS allows any origin), never through this proxy.
//   - allowLoopback: any localhost / 127.0.0.1 / [::1] port — for a local
//     dev backend. Only enabled in unpackaged (dev) runs; a packaged build
//     must not let the renderer poke arbitrary local services.
export interface ApiProxyPolicy {
  origins: ReadonlySet<string>;
  allowLoopback: boolean;
}

export function createApiProxyPolicy(opts: { apiBase?: string; allowLoopback: boolean }): ApiProxyPolicy {
  // Mirror the renderer: it uses VITE_BOSON_API_URL when set. Unset falls
  // back to production (the renderer's own unset fallback is a localhost dev
  // backend, which allowLoopback covers in dev).
  const origins = new Set<string>();
  try {
    const u = new URL(opts.apiBase || DEFAULT_API_BASE);
    if (u.protocol === 'http:' || u.protocol === 'https:') origins.add(u.origin);
  } catch { /* malformed config — allowlist stays empty (fail closed) */ }
  return { origins, allowLoopback: opts.allowLoopback };
}

function isLoopback(u: URL): boolean {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// Exact-origin match (so https://api.boson.chat.evil.com, http://api.boson.chat
// and https://api.boson.chat:8443 are all rejected), plus loopback in dev.
function allowed(u: URL, policy: ApiProxyPolicy): boolean {
  if (policy.origins.has(u.origin)) return true;
  return policy.allowLoopback && isLoopback(u);
}

export async function proxyApiFetch(req: ApiProxyRequest, policy: ApiProxyPolicy): Promise<ApiProxyResponse> {
  if (!req || typeof req.url !== 'string' || typeof req.method !== 'string') return fail('Bad request');
  let u: URL;
  try { u = new URL(req.url); } catch { return fail('Bad URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('Bad scheme');
  if (!allowed(u, policy)) return fail('Blocked host');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const body = req.body == null
      ? undefined
      : (typeof req.body === 'string' ? req.body : Buffer.from(req.body));

    // Follow redirects MANUALLY so allowed() runs on every hop. With
    // redirect:'follow' the guard only checks the initial URL — an allowed
    // host could then 302 us to http://169.254.169.254/, a LAN address or
    // any third party and the proxy would happily fetch it, defeating the
    // allowlist this function exists to enforce. Every hop must itself be
    // on the allowlist.
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
        if (!allowed(next, policy)) return fail('Blocked redirect host');

        // Cross-origin hop (e.g. between two allowlisted origins, or to a dev
        // loopback port): drop credential-bearing headers anyway, mirroring
        // the fetch spec's stripping — defence in depth if the allowlist
        // ever grows to include an origin that shouldn't see our tokens.
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
