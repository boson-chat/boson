// A network's /.well-known/boson.json in the browser: the web build's port
// of desktop/voice_discovery.go (+ files.go's files.url). It names the
// network's IRC server, auth service, voice server, directory, theme and
// files host. Fetched straight from the network's domain (the document is
// public; networks serve it with Access-Control-Allow-Origin: *), cached
// for a while. Dev / e2e builds take documents for hosts without a real
// domain from BOSON_NETWORK_JSON (tests/e2e-app/web-app.ts hands them over
// as window.bosonWebE2EEnv.networkJson).

export interface NetworkIRC { host: string; port: number; tls: boolean }

export interface NetworkVoice {
  addr: string; // host:port of the QUIC listener
  url: string; // its HTTP API base
  authUrl: string; // the auth service that issues its tokens
  source: 'well-known' | 'override';
}

export interface NetworkDiscovery {
  host: string;
  // Where the document was looked for ('' when the host has no domain).
  domain: string;
  // The domain answered (even 404 or a bad document) — not a network error.
  answered: boolean;
  irc?: NetworkIRC;
  auth?: string;
  directory?: string;
  branding?: string;
  files?: string;
  voice?: NetworkVoice;
  // Why voice was refused (a document with an invalid voice section).
  voiceError?: string;
  override?: boolean;
}

const MAX_DOC = 64 << 10;
const TIMEOUT_MS = 4_000;
const TTL_MS = 10 * 60_000;

/** The domain discovery looks at for host ('' for IPs and single labels). */
export function discoveryDomain(rawHost: string): string {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host || /[/:@ \[\]]/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return '';
  const labels = host.split('.');
  if (labels.some((l) => l === '')) return '';
  if (labels.length === 1) return '';
  // *.localhost (a local stack, scripts/setup.sh --local): localhost is
  // the domain, as boson.chat is for irc.boson.chat.
  if (labels[labels.length - 1] === 'localhost') return 'localhost';
  if (labels.length === 2) return host;
  return labels.slice(1).join('.');
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** An https base URL (http on loopback when allowed), no credentials, query or fragment, no trailing slash. */
export function cleanBaseUrl(raw: unknown, allowLoopbackHttp: boolean): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && !(allowLoopbackHttp && u.protocol === 'http:' && isLoopback(u.hostname))) return null;
  if (!u.host || u.username || u.password || u.search || u.hash) return null;
  return u.toString().replace(/\/+$/, '');
}

/** Like cleanBaseUrl, but any path and query (a theme document). */
export function cleanDocUrl(raw: unknown, allowLoopbackHttp: boolean): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && !(allowLoopbackHttp && u.protocol === 'http:' && isLoopback(u.hostname))) return null;
  if (!u.host || u.username || u.password || u.hash) return null;
  return u.toString();
}

function validHostPort(addr: unknown): addr is string {
  if (typeof addr !== 'string') return false;
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(addr);
  if (!m || !m[1]) return false;
  const p = Number(m[2]);
  return p >= 1 && p <= 65535;
}

/** Reads a boson.json document (null unless it's valid JSON, version 1). */
export function parseBosonJson(text: string, allowLoopbackHttp: boolean): Omit<NetworkDiscovery, 'host' | 'domain' | 'answered'> | null {
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(text) as Record<string, unknown>; } catch { return null; }
  if (!doc || typeof doc !== 'object' || doc['version'] !== 1) return null;
  const obj = (k: string): Record<string, unknown> | null => {
    const v = doc[k];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  };
  const out: Omit<NetworkDiscovery, 'host' | 'domain' | 'answered'> = {};
  const irc = obj('irc');
  if (irc && typeof irc['host'] === 'string' && irc['host']) {
    out.irc = { host: irc['host'].toLowerCase(), port: Number(irc['port']) || (irc['tls'] ? 6697 : 6667), tls: !!irc['tls'] };
  }
  const auth = cleanBaseUrl(obj('auth')?.['url'], allowLoopbackHttp);
  if (auth) out.auth = auth;
  const dir = cleanBaseUrl(obj('directory')?.['url'], allowLoopbackHttp);
  if (dir) out.directory = dir;
  const files = cleanBaseUrl(obj('files')?.['url'], allowLoopbackHttp);
  if (files) out.files = files;
  const b = doc['branding'];
  const branding = cleanDocUrl(typeof b === 'string' ? b : (b && typeof b === 'object' ? (b as { url?: unknown }).url : undefined), allowLoopbackHttp);
  if (branding) out.branding = branding;
  const voice = obj('voice');
  if (voice) {
    const url = cleanBaseUrl(voice['url'], allowLoopbackHttp);
    if (!auth) out.voiceError = 'boson.json: voice without auth.url';
    else if (!validHostPort(voice['addr'])) out.voiceError = 'boson.json: voice.addr is not host:port';
    else if (!url) out.voiceError = 'boson.json: voice.url is not an https base URL';
    else out.voice = { addr: String(voice['addr']).toLowerCase(), url, authUrl: auth, source: 'well-known' };
  }
  return out;
}

export interface DiscoveryOptions {
  fetch?: typeof fetch;
  allowLoopbackHttp?: boolean;
  // Documents for hosts without a domain (dev / e2e), keyed by irc.host.
  overrides?: string[];
  now?: () => number;
}

export class NetworkDiscoverer {
  private cache = new Map<string, { at: number; result: NetworkDiscovery }>();
  private inflight = new Map<string, Promise<NetworkDiscovery>>();
  private overrides = new Map<string, NetworkDiscovery>();
  private readonly doFetch: typeof fetch;
  private readonly allowHttp: boolean;
  private readonly now: () => number;

  constructor(opts: DiscoveryOptions = {}) {
    this.doFetch = opts.fetch ?? fetch.bind(globalThis);
    this.allowHttp = !!opts.allowLoopbackHttp;
    this.now = opts.now ?? Date.now;
    for (const text of opts.overrides ?? []) {
      const doc = parseBosonJson(text, true);
      if (!doc?.irc?.host || !doc.auth) {
        console.warn('discovery: a BOSON_NETWORK_JSON document needs irc.host and auth.url');
        continue;
      }
      const host = doc.irc.host;
      this.overrides.set(host, {
        host, domain: discoveryDomain(host), answered: true, override: true, ...doc,
        ...(doc.voice ? { voice: { ...doc.voice, source: 'override' as const } } : {}),
      });
    }
  }

  get allowLoopbackHttp(): boolean { return this.allowHttp; }

  override(host: string): NetworkDiscovery | null {
    return this.overrides.get(host.trim().toLowerCase()) ?? null;
  }

  /** host's network (cached for a while unless refresh). */
  discover(rawHost: string, refresh = false): Promise<NetworkDiscovery> {
    const host = rawHost.trim().toLowerCase();
    const o = this.overrides.get(host);
    if (o) return Promise.resolve(o);
    const hit = this.cache.get(host);
    if (hit && !refresh && this.now() - hit.at < TTL_MS) return Promise.resolve(hit.result);
    const running = this.inflight.get(host);
    if (running) return running;
    const p = this.lookup(host, discoveryDomain(host)).then((r) => {
      // A network error keeps an older answer, if there is one.
      const result = !r.answered && hit ? hit.result : r;
      this.cache.set(host, { at: this.now(), result });
      return result;
    }).finally(() => this.inflight.delete(host));
    this.inflight.set(host, p);
    return p;
  }

  /** The document at one domain (the "Use another server" lookup tries several). */
  async lookup(host: string, domain: string): Promise<NetworkDiscovery> {
    const base: NetworkDiscovery = { host, domain, answered: false };
    if (!domain) return base;
    const text = await this.fetchDoc(domain);
    if (text === null) return base;
    if (text === '') return { ...base, answered: true };
    return { ...base, answered: true, ...(parseBosonJson(text, this.allowHttp) ?? {}) };
  }

  // null: no answer (network error); '': answered without a usable body.
  private async fetchDoc(domain: string): Promise<string | null> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await this.doFetch(`https://${domain}/.well-known/boson.json`, {
        headers: { Accept: 'application/json' }, signal: ctl.signal, credentials: 'omit', redirect: 'follow',
      });
      if (!res.ok) return '';
      const text = await res.text();
      return text.length > MAX_DOC ? '' : text;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}

let shared: NetworkDiscoverer | null = null;

export function setNetworkDiscoverer(d: NetworkDiscoverer): void { shared = d; }

export function networkDiscoverer(): NetworkDiscoverer {
  shared ??= new NetworkDiscoverer();
  return shared;
}

export function discoverNetwork(host: string, opts: { refresh?: boolean } = {}): Promise<NetworkDiscovery> {
  return networkDiscoverer().discover(host, !!opts.refresh);
}
