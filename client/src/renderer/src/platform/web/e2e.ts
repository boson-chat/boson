// window.bosonE2E for the web build under the real-app e2e suite: the
// stand-ins for what the OS does that the web can do too. Installed only
// when the e2e config says so (tests/e2e-app/web-app.ts serves it).
// Hooks the web has no equivalent for are absent; specs that need them
// skip on the web (tests/e2e-app/README.md).

import type { WebEngine } from './engine';
import { fetchTransport, type ApiRequest, type ApiResponse } from '../../shared/http/transport';

// What the launcher hands over from the desktop app's test environment
// (tests/e2e-app/web-app.ts).
interface E2EEnv { BOSON_E2E_API_DOWN?: string }

// The desktop's API proxy test control (desktop/apiproxy.go): every API
// request (api + auth service) is logged; it can be delayed or fail like a
// backend that's down — every request ("1") or those under path prefixes.
// On the web the requests are direct fetches; this wraps them.
function apiControl(env: E2EEnv) {
  const log: string[] = [];
  let down = env.BOSON_E2E_API_DOWN === '1';
  let downPaths = env.BOSON_E2E_API_DOWN && env.BOSON_E2E_API_DOWN !== '1' ? env.BOSON_E2E_API_DOWN.split(',') : [];
  let delayMs = 0;
  return {
    fetch: async (req: ApiRequest): Promise<ApiResponse> => {
      const u = new URL(req.url);
      log.push(`${req.method} ${u.pathname}${u.search}`);
      const fail = down || downPaths.some((p) => p !== '' && u.pathname.startsWith(p));
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) return { status: 0, ok: false, statusText: 'connection refused', text: '' };
      return fetchTransport(req);
    },
    set: (d: boolean, ms: number) => { down = d; delayMs = ms; downPaths = []; },
    requests: () => [...log],
  };
}

export function installWebE2E(w: Record<string, unknown>, deps: { deliverDeepLink: (url: string) => void; engine: WebEngine }): void {
  const opened: string[] = [];
  const realOpen = window.open.bind(window);
  // Links the app opens in a new tab are recorded instead (a test never
  // opens real sites), except the app's own SSO popup.
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (url !== undefined && target !== 'boson-sso') {
      opened.push(new URL(String(url), location.href).href);
      return null;
    }
    return realOpen(url, target, features);
  }) as typeof window.open;
  document.addEventListener('click', (ev) => {
    const a = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || ev.defaultPrevented) return;
    const dest = new URL(a.href, location.href);
    if (dest.origin === location.origin) return;
    ev.preventDefault();
    opened.push(dest.href);
  }, true);
  const env = ((window as unknown as { bosonWebE2EEnv?: E2EEnv }).bosonWebE2EEnv) ?? {};
  const api = apiControl(env);
  w.bosonApi = { fetch: api.fetch };
  w.bosonE2E = {
    web: true,
    setApi: async (down: boolean, delayMs: number) => api.set(down, delayMs),
    apiRequests: async () => api.requests(),
    openedLinks: async () => [...opened],
    // A second launch with a boson:// URL: on the web, a link to the app
    // carrying it, while the app is open.
    // The engine dying under the app (helpers/engine.ts).
    crashEngine: async () => deps.engine.crash(),
    engineSession: async () => deps.engine.session(),
    secondInstance: async (args: string[]) => {
      for (const a of args) if (a.startsWith('boson://')) deps.deliverDeepLink(a);
    },
    // Spotify's embed pages for the API's fetcher (desktop: StubSpotify in
    // desktop/e2e.go), served by the e2e web server (tests/e2e-app/web-server.ts).
    stubSpotify: async (pages: Record<string, string>) => {
      await fetch('/__e2e/spotify', { method: 'POST', body: JSON.stringify(pages) });
    },
    spotifyFetched: async () => (await fetch('/__e2e/spotify')).json() as Promise<string[]>,
  };
}
