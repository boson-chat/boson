// Voice discovery for the web build (desktop/voice_discovery.go): an IRC
// host's domain (its host minus the first label) publishes
// https://<domain>/.well-known/boson.json naming its voice server and
// auth service. The desktop's fallback, a QUIC probe of voice.<domain>,
// can't be done from a page; the web tries the voice server's public API
// at https://voice.<domain>/v1/info instead. Results are cached for a day
// (localStorage). Dev/e2e builds may name documents for hosts without a
// real domain (BOSON_NETWORK_JSON / BOSON_VOICE_JSON, as file contents).

export interface VoiceInfo {
  addr: string; // host:port of the QUIC (and WebTransport) listener
  url: string; // the voice server's HTTPS API
  authUrl: string;
  source: 'well-known' | 'probe' | 'override';
}

export interface Discovery {
  host: string;
  voice: VoiceInfo | null;
  checkedAt: number;
  definitive: boolean;
}

const TTL_MS = 24 * 3600_000;
const TIMEOUT_MS = 2000;
const CACHE_KEY = 'boson:voice-servers:v1';

export function voiceDomain(rawHost: string): string {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host || /[/:@ ]/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return '';
  const labels = host.split('.');
  if (labels.some((l) => l === '')) return '';
  if (labels.length === 1) return '';
  // *.localhost (a local stack, scripts/setup.sh --local): localhost is
  // the domain, as boson.chat is for irc.boson.chat.
  if (labels[labels.length - 1] === 'localhost') return 'localhost';
  if (labels.length === 2) return host;
  return labels.slice(1).join('.');
}

export function isLoopbackHost(h: string): boolean {
  const x = h.replace(/^\[|\]$/g, '').toLowerCase();
  return x === 'localhost' || x.endsWith('.localhost') || x === '::1' || /^127\./.test(x);
}

/** An https base URL (http when allowed), no query/fragment/credentials, no trailing slash. */
export function cleanBaseURL(raw: string, allowHTTP: boolean): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && !(allowHTTP && u.protocol === 'http:')) return null;
  if (!u.host || u.username || u.password || u.search || u.hash) return null;
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`.replace(/\/+$/, '');
}

function validHostPort(addr: string): boolean {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(addr);
  if (!m) return false;
  const p = Number(m[2]);
  return p >= 1 && p <= 65535 && m[1] !== '';
}

export function splitHostPort(addr: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(addr);
  return m ? { host: m[1]!.replace(/^\[|\]$/g, ''), port: Number(m[2]) } : null;
}

interface WellKnown {
  version?: number;
  irc?: { host?: string; port?: number; tls?: boolean };
  auth?: { url?: string };
  voice?: { addr?: string; url?: string };
}

/** A boson.json's voice (null when it has none); throws when it's invalid. */
export function parseWellKnown(doc: WellKnown, allowHTTP: boolean): VoiceInfo | null {
  if (doc.version !== 1) throw new Error('boson.json: unsupported version');
  if (!doc.voice) return null;
  if (!doc.auth?.url) throw new Error('boson.json: voice without auth.url');
  const addr = (doc.voice.addr ?? '').toLowerCase();
  if (!validHostPort(addr)) throw new Error('boson.json: voice.addr');
  const url = cleanBaseURL(doc.voice.url ?? '', allowHTTP);
  const authUrl = cleanBaseURL(doc.auth.url, allowHTTP);
  if (!url || !authUrl) throw new Error('boson.json: bad url');
  return { addr, url, authUrl, source: 'well-known' };
}

/**
 * Voice the app may use: tied to authBase, with the voice server's QUIC
 * and HTTPS hosts under the auth service's domain (loopback too in dev).
 */
export function voiceTrusted(info: VoiceInfo | null, authBase: string, dev: boolean): boolean {
  if (!info) return false;
  const want = cleanBaseURL(authBase, dev);
  if (!want || info.authUrl !== want) return false;
  const authDomain = voiceDomain(new URL(want).hostname);
  const under = (h: string): boolean => {
    const host = h.toLowerCase();
    if (dev && isLoopbackHost(host)) return true;
    return authDomain !== '' && (host === authDomain || host.endsWith(`.${authDomain}`));
  };
  const hp = splitHostPort(info.addr);
  if (!hp) return false;
  let vh: string;
  try { vh = new URL(info.url).hostname; } catch { return false; }
  return under(hp.host) && under(vh);
}

export interface DiscovererOptions {
  dev: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  storage?: Storage | null;
  // Dev/e2e: boson.json documents (their contents) for hosts without a
  // real domain, keyed by their irc.host.
  overrides?: string[];
}

export class VoiceDiscoverer {
  private cache = new Map<string, Discovery>();
  private inflight = new Map<string, Promise<Discovery>>();
  private overrides = new Map<string, VoiceInfo>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly storage: Storage | null;

  constructor(private opts: DiscovererOptions) {
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
    this.storage = opts.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : opts.storage;
    for (const text of opts.overrides ?? []) {
      try {
        const doc = JSON.parse(text) as WellKnown;
        const info = parseWellKnown(doc, true);
        const host = doc.irc?.host?.toLowerCase();
        if (info && host) this.overrides.set(host, { ...info, source: 'override' });
      } catch { /* ignore a bad document */ }
    }
    this.load();
  }

  cached(rawHost: string): Discovery | null {
    const host = rawHost.trim().toLowerCase();
    const o = this.overrides.get(host);
    if (o) return { host, voice: o, checkedAt: this.now(), definitive: true };
    return this.cache.get(host) ?? null;
  }

  async discover(rawHost: string, refresh: boolean): Promise<Discovery> {
    const host = rawHost.trim().toLowerCase();
    const c = this.cached(host);
    if (c && (c.voice?.source === 'override' || (!refresh && this.now() - c.checkedAt < TTL_MS))) return c;
    const running = this.inflight.get(host);
    if (running) return running;
    const p = this.check(host).then((res) => {
      const prev = this.cache.get(host);
      const out = !res.definitive && !res.voice && prev?.voice ? prev : res;
      this.cache.set(host, out);
      this.save();
      return out;
    }).finally(() => this.inflight.delete(host));
    this.inflight.set(host, p);
    return p;
  }

  private async get(url: string): Promise<Response | null> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      return await this.fetchFn(url, { signal: ctl.signal, redirect: 'error', headers: { Accept: 'application/json' } });
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  private async check(host: string): Promise<Discovery> {
    const res: Discovery = { host, voice: null, checkedAt: this.now(), definitive: false };
    const domain = voiceDomain(host);
    if (!domain) {
      res.definitive = true;
      return res;
    }
    const r = await this.get(`https://${domain}/.well-known/boson.json`);
    let answered = false;
    if (r) {
      answered = true;
      if (r.ok) {
        try {
          const info = parseWellKnown((await r.json()) as WellKnown, this.opts.dev);
          if (info) {
            res.voice = info;
            res.definitive = true;
            return res;
          }
        } catch { /* invalid: fall through to the probe */ }
      }
    }
    // The desktop's QUIC probe, the web's way: the voice API answers.
    const probe = await this.get(`https://voice.${domain}/v1/info`);
    if (probe?.ok) {
      let port = 7700;
      try {
        const info = (await probe.json()) as { quic_port?: number };
        if (info.quic_port) port = info.quic_port;
      } catch { /* default port */ }
      res.voice = { addr: `voice.${domain}:${port}`, url: `https://voice.${domain}`, authUrl: `https://auth.${domain}`, source: 'probe' };
      res.definitive = true;
      return res;
    }
    res.definitive = answered;
    return res;
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(CACHE_KEY);
      if (!raw) return;
      for (const d of Object.values(JSON.parse(raw) as Record<string, Discovery>)) {
        if (!d || typeof d.host !== 'string') continue;
        if (d.voice && (!validHostPort(d.voice.addr) || !cleanBaseURL(d.voice.url, this.opts.dev) || !cleanBaseURL(d.voice.authUrl, this.opts.dev))) continue;
        this.cache.set(d.host, d);
      }
    } catch { /* corrupt cache */ }
  }

  private save(): void {
    try {
      this.storage?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(this.cache)));
    } catch { /* quota */ }
  }
}
