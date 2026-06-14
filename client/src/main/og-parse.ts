// Pure helpers for the link-unfurl feature: parse OpenGraph/title metadata out
// of an HTML string, resolve a relative og:image, and decide whether a host is
// safe to fetch (block loopback/private ranges — a basic SSRF guard). No
// Electron / Node imports here so it's unit-testable in the renderer's vitest.

export interface OgCard {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  author?: string;
  date?: string; // ISO 8601 publish/upload date when the page exposes one
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}
function safeFromCodePoint(n: number): string {
  try { return Number.isFinite(n) ? String.fromCodePoint(n) : ''; } catch { return ''; }
}

// Pull a <meta property="X"> / <meta name="X"> content value (attr order-agnostic).
function metaContent(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*["']${escapeRe(key)}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return undefined;
  const c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
  const v = c?.[1]?.trim();
  return v ? decodeEntities(v) : undefined;
}
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// <meta itemprop="X" content="Y"> (schema.org microdata).
function metaItemprop(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta\\b[^>]*\\bitemprop\\s*=\\s*["']${escapeRe(key)}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return undefined;
  const c = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
  const v = c?.[1]?.trim();
  return v ? decodeEntities(v) : undefined;
}

// A simple "key":"value" out of an inline JSON-LD blob (best-effort, no parse).
function jsonStr(html: string, key: string): string | undefined {
  const m = new RegExp(`"${escapeRe(key)}"\\s*:\\s*"([^"\\\\]{1,300})"`, 'i').exec(html);
  return m ? decodeEntities(m[1]!) : undefined;
}

// author can be "author":"X" or "author":{ ... "name":"X" ... } in JSON-LD,
// or a microdata <link itemprop="name" content="X">.
function extractAuthor(html: string): string | undefined {
  const direct = /"author"\s*:\s*"([^"\\]{1,160})"/i.exec(html);
  if (direct) return decodeEntities(direct[1]!);
  const obj = /"author"\s*:\s*\{[^}]{0,400}?"name"\s*:\s*"([^"\\]{1,160})"/i.exec(html);
  if (obj) return decodeEntities(obj[1]!);
  const link = /<link\b[^>]*\bitemprop\s*=\s*["']name["'][^>]*\bcontent\s*=\s*["']([^"']{1,160})["'][^>]*>/i.exec(html);
  return link ? decodeEntities(link[1]!) : undefined;
}

export function parseOg(html: string, url: string): OgCard {
  // Most sites keep metadata in <head>, but some (e.g. YouTube) emit OG tags and
  // JSON-LD far down the document, so scan generously.
  const head = html.slice(0, 1_200_000);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const card: OgCard = { url };
  const title = metaContent(head, 'og:title') ?? (titleTag ? decodeEntities(titleTag.trim()) : undefined);
  const description = metaContent(head, 'og:description') ?? metaContent(head, 'description');
  const image = absolutize(metaContent(head, 'og:image') ?? metaContent(head, 'twitter:image'), url);
  const siteName = metaContent(head, 'og:site_name');
  const author = metaContent(head, 'author') ?? metaContent(head, 'article:author')
    ?? metaContent(head, 'og:article:author') ?? extractAuthor(head);
  const date = metaContent(head, 'article:published_time') ?? metaContent(head, 'og:article:published_time')
    ?? metaItemprop(head, 'datePublished') ?? jsonStr(head, 'uploadDate') ?? jsonStr(head, 'datePublished');
  if (title) card.title = title;
  if (description) card.description = description;
  if (image) card.image = image;
  if (siteName) card.siteName = siteName;
  if (author) card.author = author;
  if (date) card.date = date;
  return card;
}

// Resolve a possibly-relative image URL against the page URL; only http(s).
export function absolutize(img: string | undefined, base: string): string | undefined {
  if (!img) return undefined;
  try {
    const u = new URL(img, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// Block loopback / link-local / private (RFC1918) hosts so an unfurl can't be
// pointed at the user's own LAN / metadata endpoints.
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  // IPv4 ranges
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;          // link-local
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 unique-local / link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}
