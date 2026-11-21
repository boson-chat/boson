// window.bosonUnfurl and window.bosonSpotify on the web (desktop/unfurl.go,
// spotify.go): a page can't fetch other sites (CORS), so the boson API
// fetches them (GET /v1/unfurl, /v1/unfurl/spotify; boson-chat/backend
// pkg/unfurl, SSRF-guarded) and answers with the same JSON as the
// desktop's fetchers. No answer (no preview, refused, rate limited, API
// unreachable) is null, as on the desktop.
import type { OgCard } from '../../shared/unfurl';
import type { SpotifyInfo } from '../../shared/spotify';

export type TokenSource = () => Promise<string | null>;

export interface WebUnfurlBridges {
  unfurl: { fetch(url: string): Promise<OgCard | null>; setTokenSource(fn: TokenSource | null): void };
  spotify: { fetch(url: string): Promise<SpotifyInfo | null> };
}

export function webUnfurlBridges(apiUrl: string, fetchFn: typeof fetch = (...a) => fetch(...a)): WebUnfurlBridges {
  const base = apiUrl.replace(/\/+$/, '');
  // Signed in: the API limits the user, not the address everyone behind
  // it shares (main.tsx sets this).
  let token: TokenSource | null = null;
  async function get<T>(path: string, url: string): Promise<T | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    const headers: Record<string, string> = { Accept: 'application/json' };
    const t = token ? await token().catch(() => null) : null;
    if (t) headers['Authorization'] = `Bearer ${t}`;
    try {
      const res = await fetchFn(`${base}${path}?url=${encodeURIComponent(url)}`, { headers, credentials: 'omit' });
      if (res.status !== 200) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
  return {
    unfurl: {
      fetch: (url) => get<OgCard>('/v1/unfurl', url),
      setTokenSource: (fn) => { token = fn; },
    },
    spotify: { fetch: (url) => get<SpotifyInfo>('/v1/unfurl/spotify', url) },
  };
}
