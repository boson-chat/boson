// Rich Spotify metadata without API credentials. Spotify's embed page server-
// renders the entity (title, cover, and — for playlists/albums — the full track
// list, each with a 30s preview MP3) into a __NEXT_DATA__ JSON blob. We fetch
// that and parse it so the renderer can show a native track list + previews,
// instead of mounting Spotify's own iframe (which crashes in Electron's frame).

export interface SpotifyTrack {
  title: string;
  artist: string;
  durationMs: number;
  previewUrl?: string;
}

export interface SpotifyInfo {
  url: string;
  type: string;       // track | album | playlist | artist | episode | show
  title: string;
  subtitle?: string;  // artist(s) for a track; owner/description otherwise
  cover?: string;
  durationMs?: number;
  previewUrl?: string; // single-track 30s preview
  tracks?: SpotifyTrack[];
}

const TYPES = new Set(['track', 'album', 'playlist', 'artist', 'episode', 'show']);
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 2 * 1024 * 1024; // embed pages are ~90KB–1MB
const TTL_MS = 30 * 60 * 1000;
const NEG_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 200;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const cache = new Map<string, { at: number; info: SpotifyInfo | null }>();

// Build the canonical embed URL from a Spotify link (also our SSRF guard: we
// only ever fetch open.spotify.com/embed/<type>/<id>).
export function spotifyEmbedUrl(rawUrl: string): { embed: string; type: string } | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return null;
  const m = /^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?([a-z]+)\/([A-Za-z0-9]+)/.exec(u.pathname);
  if (!m || !TYPES.has(m[1]!)) return null;
  return { embed: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, type: m[1]! };
}

function pickCover(e: Record<string, unknown>): string | undefined {
  const srcs = (e['coverArt'] as { sources?: { url?: string; width?: number }[] } | undefined)?.sources;
  if (Array.isArray(srcs) && srcs.length) {
    const best = [...srcs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    if (best?.url) return best.url;
  }
  const imgs = (e['visualIdentity'] as { image?: { url?: string; maxWidth?: number }[] } | undefined)?.image;
  if (Array.isArray(imgs) && imgs.length) {
    const best = [...imgs].sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0))[0];
    if (best?.url) return best.url;
  }
  return undefined;
}

export function parseSpotifyNextData(html: string, url: string): SpotifyInfo | null {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let data: unknown;
  try { data = JSON.parse(m[1]!); } catch { return null; }
  const e = (data as { props?: { pageProps?: { state?: { data?: { entity?: Record<string, unknown> } } } } })
    ?.props?.pageProps?.state?.data?.entity;
  if (!e || typeof e['type'] !== 'string') return null;
  const title = (e['title'] as string) || (e['name'] as string) || '';
  if (!title) return null;

  const info: SpotifyInfo = { url, type: e['type'] as string, title };
  const artists = e['artists'] as { name?: string }[] | undefined;
  if (Array.isArray(artists) && artists.length) info.subtitle = artists.map((a) => a.name).filter(Boolean).join(', ');
  else if (typeof e['subtitle'] === 'string' && e['subtitle']) info.subtitle = e['subtitle'] as string;
  const cover = pickCover(e);
  if (cover) info.cover = cover;
  if (typeof e['duration'] === 'number') info.durationMs = e['duration'] as number;
  const preview = (e['audioPreview'] as { url?: string } | undefined)?.url;
  if (preview) info.previewUrl = preview;

  const tl = e['trackList'] as Record<string, unknown>[] | undefined;
  if (Array.isArray(tl)) {
    info.tracks = tl.slice(0, 100).map((t) => {
      const track: SpotifyTrack = {
        title: (t['title'] as string) || '',
        artist: (t['subtitle'] as string) || '',
        durationMs: typeof t['duration'] === 'number' ? (t['duration'] as number) : 0,
      };
      const p = (t['audioPreview'] as { url?: string } | undefined)?.url;
      if (p) track.previewUrl = p;
      return track;
    }).filter((t) => t.title);
  }
  return info;
}

export async function fetchSpotifyInfo(rawUrl: string): Promise<SpotifyInfo | null> {
  const ref = spotifyEmbedUrl(rawUrl);
  if (!ref) return null;

  const hit = cache.get(ref.embed);
  if (hit && Date.now() - hit.at < (hit.info ? TTL_MS : NEG_TTL_MS)) return hit.info;

  let info: SpotifyInfo | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(ref.embed, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'text/html' } });
      if (res.ok && res.body) {
        const html = await readCapped(res.body, MAX_BYTES);
        info = parseSpotifyNextData(html, rawUrl);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    info = null;
  }

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(ref.embed, { at: Date.now(), info });
  return info;
}

async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); total += value.length; if (total >= cap) break; }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder('utf-8', { fatal: false }).decode(out);
}
