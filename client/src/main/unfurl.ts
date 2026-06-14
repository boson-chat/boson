// Main-process link unfurler. The renderer can't fetch arbitrary sites (CORS),
// so it asks main (via the `unfurl:fetch` IPC) which fetches the page and
// returns parsed OpenGraph/title metadata. Privacy: this only runs when the
// user explicitly clicks "load preview" (click-to-load default), and never for
// loopback/private hosts (SSRF guard in og-parse).
import { parseOg, isBlockedHost, type OgCard } from './og-parse';

const TTL_MS = 30 * 60 * 1000;
const NEG_TTL_MS = 60 * 1000; // failures expire fast so transient errors recover
const MAX_ENTRIES = 200;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024; // only need the <head>; cap the read
// YouTube emits its OG tags + JSON-LD (title/author/uploadDate) ~640–700KB into
// the document, so it needs a larger read than typical pages.
const YT_MAX_BYTES = 1100 * 1024;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

// Many sites (Cloudflare et al.) reject non-browser user-agents with a 403, so
// present as a mainstream desktop browser to get the real HTML + OG tags.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const cache = new Map<string, { at: number; card: OgCard | null }>();

export async function unfurl(rawUrl: string): Promise<OgCard | null> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (isBlockedHost(u.hostname)) return null;

  const hit = cache.get(rawUrl);
  if (hit && Date.now() - hit.at < (hit.card ? TTL_MS : NEG_TTL_MS)) return hit.card;

  let card: OgCard | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(rawUrl, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      const ct = res.headers.get('content-type') ?? '';
      if (res.ok && ct.includes('text/html') && res.body) {
        const cap = YT_HOSTS.has(u.hostname.toLowerCase()) ? YT_MAX_BYTES : MAX_BYTES;
        const html = await readCapped(res.body, cap);
        // Re-check the final URL (post-redirect) isn't a blocked host.
        const finalHost = (() => { try { return new URL(res.url || rawUrl).hostname; } catch { return ''; } })();
        if (!finalHost || !isBlockedHost(finalHost)) {
          card = parseOg(html, res.url || rawUrl);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    card = null;
  }

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(rawUrl, { at: Date.now(), card });
  return card;
}

// Read a web ReadableStream up to `cap` bytes, then stop (don't slurp huge pages).
async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total >= cap) break;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
