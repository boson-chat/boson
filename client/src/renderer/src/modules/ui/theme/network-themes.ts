import { isBrandingUrl, parseNetworkTheme, themeHasLook, themeImages, type ImageSlot, type NetworkTheme } from './network-theme';
import type { NetworkOverlay } from './theme.store';

// Network themes: which theme each network (IRC host) has, kept fresh and
// cached, and which one is on screen.
//
// A network's theme is found, in order:
//   1. its /.well-known/boson.json `branding` URL (the shell's discovery,
//      desktop/netauth.go);
//   2. else its auth service's /v1/config `branding_url`;
//   3. else its directory listing's `theme`.
// The document is cached per network in localStorage with its ETag (the
// colours paint at launch, before anything is fetched) and revalidated
// when the network connects. Images are fetched through the desktop shell
// (desktop/branding.go: https only, size and type limits, no private
// addresses) and shown from blob: URLs, so the page's CSP needn't allow
// arbitrary image hosts; without the shell (a browser) they're fetched
// directly.
//
// What's applied: the active server's theme over the user's, unless the
// user turned network themes off (Appearance → "Use network themes") or
// off for that network ("Use this network's theme"). Both are local
// settings. The network's logo (rail tile, sidebar header) and sign-in
// background follow the same switches.

// window.bosonBranding (platform/wails.ts → desktop/branding.go).
export interface BrandingBridge {
  fetch(url: string, etag: string): Promise<{ status: number; etag?: string; body?: string; error?: string }>;
  image(url: string): Promise<{ contentType?: string; data?: string; error?: string }>;
  // Dev / e2e builds: the shell fetches http:// on loopback too.
  allowLoopbackHttp: boolean;
}

export function brandingBridge(): BrandingBridge | null {
  return (globalThis as { bosonBranding?: BrandingBridge }).bosonBranding ?? null;
}

export type ThemeSource = 'well-known' | 'auth' | 'directory';

// What a network's branding looks like to the UI right now.
export interface NetworkBranding {
  // The network has a theme.
  available: boolean;
  // Its theme changes the app's look (not just the sign-in screen).
  hasLook: boolean;
  // "Use this network's theme" (per network, on unless turned off).
  enabled: boolean;
  // Network themes are on, for this network, and it has one.
  applied: boolean;
  source?: ThemeSource;
  // Loaded image URLs; only while applied.
  logo?: string;
  logoWide?: string;
  loginBackground?: string;
}

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface NetworkThemesDeps {
  // boson.json discovery for an IRC host: its branding URL and auth service.
  discover?: (host: string) => Promise<{ brandingUrl?: string; authUrl?: string } | null>;
  // The auth service's public /v1/config.
  authConfig?: (authUrl: string) => Promise<{ branding_url?: string | null } | null>;
  bridge?: BrandingBridge | null;
  storage?: KV | null;
  fetch?: typeof fetch;
  createObjectURL?: (b: Blob) => string;
  // Applies the overlay (ThemeStore.setNetworkOverlay).
  apply?: (overlay: NetworkOverlay | null) => void;
  // How long a revalidation is skipped after the last one (unless forced).
  minRefreshMs?: number;
}

interface CacheEntry {
  source: ThemeSource;
  // The document's URL (sources 1 and 2).
  url?: string;
  etag?: string;
  // The document as received (JSON).
  text: string;
}

const CACHE_KEY = 'boson:network-themes:v1';
const ENABLED_KEY = 'boson:network-themes:enabled';
const OFF_KEY = 'boson:network-themes:off:v1';
const MAX_CACHED = 64;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
// The key boson.chat's own branding (the default login screen) is kept under.
export const MAIN_NETWORK_KEY = '@main';

const hostKey = (h: string): string => h.trim().toLowerCase();

function defaultStorage(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

function base64Blob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export class NetworkThemes {
  private readonly deps: NetworkThemesDeps;
  private cache: Record<string, CacheEntry>;
  private docs = new Map<string, NetworkTheme>();
  private listings = new Map<string, unknown>();
  private readonly images = new Map<string, string | null>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly refreshedAt = new Map<string, number>();
  private active: string | null = null;
  private enabled: boolean;
  private off: Set<string>;
  private readonly listeners = new Set<() => void>();
  private brandingMemo = new Map<string, NetworkBranding>();
  private overlay: NetworkOverlay | null = null;
  private overlayKey = '';

  constructor(deps: NetworkThemesDeps = {}) {
    this.deps = deps;
    this.cache = this.readJson<Record<string, CacheEntry>>(CACHE_KEY) ?? {};
    this.enabled = this.storage()?.getItem(ENABLED_KEY) !== 'false';
    const off = this.readJson<unknown>(OFF_KEY);
    this.off = new Set(Array.isArray(off) ? off.filter((h): h is string => typeof h === 'string') : []);
    for (const [host, entry] of Object.entries(this.cache)) {
      const doc = entry && typeof entry.text === 'string' ? this.parse(entry.text) : null;
      if (doc) this.docs.set(host, doc);
      else delete this.cache[host];
    }
  }

  // ---- state ----

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    this.brandingMemo = new Map();
    this.applyOverlay();
    this.listeners.forEach((fn) => fn());
  }

  // The network's validated theme document (null: none).
  themeFor(rawHost: string): NetworkTheme | null {
    return this.docs.get(hostKey(rawHost)) ?? null;
  }

  brandingFor(rawHost: string): NetworkBranding {
    const host = hostKey(rawHost);
    const hit = this.brandingMemo.get(host);
    if (hit) return hit;
    const doc = this.docs.get(host) ?? null;
    const enabled = !this.off.has(host);
    const applied = !!doc && this.enabled && enabled;
    const img = (url: string | undefined): string | undefined => (applied && url ? this.images.get(url) ?? undefined : undefined);
    const out: NetworkBranding = {
      available: !!doc,
      hasLook: !!doc && themeHasLook(doc),
      enabled,
      applied,
      ...(doc ? { source: this.cache[host]?.source } : {}),
      ...(img(doc?.logo) ? { logo: img(doc?.logo) } : {}),
      ...(img(doc?.logo_wide) ? { logoWide: img(doc?.logo_wide) } : {}),
      ...(img(doc?.login_background) ? { loginBackground: img(doc?.login_background) } : {}),
    };
    this.brandingMemo.set(host, out);
    if (applied) this.ensureImages(host);
    return out;
  }

  // ---- settings ----

  get globallyEnabled(): boolean {
    return this.enabled;
  }

  setGloballyEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    try {
      if (on) this.storage()?.removeItem(ENABLED_KEY);
      else this.storage()?.setItem(ENABLED_KEY, 'false');
    } catch { /* storage off */ }
    this.emit();
  }

  isNetworkEnabled(rawHost: string): boolean {
    return !this.off.has(hostKey(rawHost));
  }

  setNetworkEnabled(rawHost: string, on: boolean): void {
    const host = hostKey(rawHost);
    if (on === !this.off.has(host)) return;
    if (on) this.off.delete(host); else this.off.add(host);
    this.writeJson(OFF_KEY, [...this.off]);
    this.emit();
  }

  // ---- the active server ----

  setActive(rawHost: string | null): void {
    const host = rawHost ? hostKey(rawHost) : null;
    if (host === this.active) return;
    this.active = host;
    if (host) this.ensureImages(host);
    this.applyOverlay();
  }

  private applyOverlay(): void {
    const host = this.active;
    const doc = host ? this.docs.get(host) : undefined;
    let next: NetworkOverlay | null = null;
    let key = '';
    if (host && doc && this.enabled && !this.off.has(host)) {
      const images: Partial<Record<ImageSlot, string>> = {};
      for (const [slot, url] of Object.entries(themeImages(doc)) as Array<[ImageSlot, string]>) {
        const loaded = this.images.get(url);
        if (loaded) images[slot] = loaded;
      }
      key = `${host}\n${this.cache[host]?.text ?? ''}\n${JSON.stringify(images)}`;
      next = key === this.overlayKey && this.overlay ? this.overlay : { host, theme: doc, images };
    }
    if (key === this.overlayKey && next === this.overlay) return;
    this.overlayKey = key;
    this.overlay = next;
    this.deps.apply?.(next);
  }

  // ---- directory listings (source 3) ----

  // The theme the network's directory listing carries (undefined: none).
  // Used unless the network serves its own.
  setListingTheme(rawHost: string, theme: unknown): void {
    const host = hostKey(rawHost);
    const prev = this.listings.get(host);
    if (prev === theme || (prev !== undefined && theme !== undefined && JSON.stringify(prev) === JSON.stringify(theme))) return;
    if (theme === undefined) this.listings.delete(host); else this.listings.set(host, theme);
    const cur = this.cache[host];
    // The network's own theme wins; a listing fills in when there's none
    // (or the last one came from a listing).
    if (!cur || cur.source === 'directory') this.applyListing(host);
  }

  private applyListing(host: string): void {
    const raw = this.listings.get(host);
    const doc = raw === undefined ? null : this.parse(raw);
    if (doc) {
      this.set(host, { source: 'directory', text: JSON.stringify(raw) }, doc);
    } else if (this.cache[host]) {
      this.drop(host);
    }
  }

  // ---- resolving ----

  // Looks the network's theme up again (on connect: force). Deduped while
  // one runs, and skipped for a short while after one finished unless forced.
  refresh(rawHost: string, opts: { force?: boolean } = {}): Promise<void> {
    const host = hostKey(rawHost);
    if (!host || host === MAIN_NETWORK_KEY) return Promise.resolve();
    return this.run(host, !!opts.force, async () => {
      const ok = await this.fromNetwork(host).catch(() => false);
      if (!ok) this.applyListing(host);
    });
  }

  // boson.chat's own branding (the default login screen): its auth
  // /v1/config branding_url.
  refreshMain(config: () => Promise<{ branding_url?: string | null } | null>, opts: { force?: boolean } = {}): Promise<void> {
    return this.run(MAIN_NETWORK_KEY, !!opts.force, async () => {
      let url: string | null | undefined;
      try { url = (await config())?.branding_url; } catch { return; }
      const ok = !!url && this.validUrl(url) && await this.fetchDoc(MAIN_NETWORK_KEY, url, 'auth').catch(() => false);
      if (!ok && this.cache[MAIN_NETWORK_KEY]) this.drop(MAIN_NETWORK_KEY);
    });
  }

  private run(host: string, force: boolean, fn: () => Promise<void>): Promise<void> {
    const running = this.refreshing.get(host);
    if (running) return running;
    const last = this.refreshedAt.get(host);
    if (!force && last !== undefined && Date.now() - last < (this.deps.minRefreshMs ?? 60_000)) return Promise.resolve();
    const p = fn().catch(() => {}).finally(() => {
      this.refreshing.delete(host);
      this.refreshedAt.set(host, Date.now());
    });
    this.refreshing.set(host, p);
    return p;
  }

  // Sources 1 and 2. true: the network decided (a theme, unchanged, or
  // unreachable with a cached one kept); false: fall back to its listing.
  private async fromNetwork(host: string): Promise<boolean> {
    let disc: { brandingUrl?: string; authUrl?: string } | null = null;
    try { disc = (await this.deps.discover?.(host)) ?? null; } catch { disc = null; }
    let url = disc?.brandingUrl;
    let source: ThemeSource = 'well-known';
    if ((!url || !this.validUrl(url)) && disc?.authUrl && this.deps.authConfig) {
      try { url = (await this.deps.authConfig(disc.authUrl))?.branding_url ?? undefined; } catch { url = undefined; }
      source = 'auth';
    }
    if (!url || !this.validUrl(url)) return false;
    return this.fetchDoc(host, url, source);
  }

  private async fetchDoc(host: string, url: string, source: ThemeSource): Promise<boolean> {
    const prev = this.cache[host];
    const etag = prev && prev.url === url ? prev.etag ?? '' : '';
    const res = await this.getDoc(url, etag);
    if (res.status === 304 && prev && prev.url === url) return true;
    if (res.status === 200 && res.body) {
      const doc = this.parse(res.body);
      if (!doc) return false;
      this.set(host, { source, url, ...(res.etag ? { etag: res.etag } : {}), text: res.body }, doc);
      return true;
    }
    // Unreachable (offline, timed out): keep what we had from it.
    if (res.status === 0 && prev && prev.url === url) return true;
    return false;
  }

  private async getDoc(url: string, etag: string): Promise<{ status: number; etag?: string; body?: string }> {
    const bridge = this.bridge();
    if (bridge) {
      try {
        return await bridge.fetch(url, etag);
      } catch {
        return { status: 0 };
      }
    }
    const f = this.deps.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) return { status: 0 };
    try {
      const res = await f(url, { headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) }, redirect: 'follow' });
      if (res.status !== 200) return { status: res.status };
      const body = await res.text();
      return { status: 200, etag: res.headers.get('ETag') ?? undefined, body };
    } catch {
      return { status: 0 };
    }
  }

  private set(host: string, entry: CacheEntry, doc: NetworkTheme): void {
    const same = this.cache[host]?.text === entry.text && this.cache[host]?.source === entry.source;
    this.cache[host] = entry;
    this.docs.set(host, doc);
    this.persist();
    if (same) return;
    this.ensureImages(host);
    this.emit();
  }

  private drop(host: string): void {
    delete this.cache[host];
    this.docs.delete(host);
    this.persist();
    this.emit();
  }

  // ---- images ----

  private ensureImages(host: string): void {
    const doc = this.docs.get(host);
    if (!doc) return;
    for (const url of Object.values(themeImages(doc))) {
      if (this.images.has(url) || this.loading.has(url)) continue;
      const p = this.loadImage(url).then((src) => {
        this.images.set(url, src);
        this.loading.delete(url);
        if (src) this.emit();
      });
      this.loading.set(url, p);
    }
  }

  private async loadImage(url: string): Promise<string | null> {
    const make = this.deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
    const bridge = this.bridge();
    try {
      if (bridge) {
        const r = await bridge.image(url);
        if (!r.data || !r.contentType || !IMAGE_TYPES.includes(r.contentType)) return null;
        return make(base64Blob(r.data, r.contentType));
      }
      const f = this.deps.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      if (!f) return null;
      const res = await f(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      const type = (blob.type || res.headers.get('Content-Type') || '').split(';')[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.includes(type) || blob.size > IMAGE_MAX_BYTES) return null;
      return make(blob.type === type ? blob : new Blob([blob], { type }));
    } catch {
      return null;
    }
  }

  // ---- helpers ----

  private bridge(): BrandingBridge | null {
    return this.deps.bridge === undefined ? brandingBridge() : this.deps.bridge;
  }

  private get allowLoopbackHttp(): boolean {
    return !!this.bridge()?.allowLoopbackHttp;
  }

  private validUrl(url: string): boolean {
    return isBrandingUrl(url, { allowLoopbackHttp: this.allowLoopbackHttp });
  }

  private parse(raw: unknown): NetworkTheme | null {
    return parseNetworkTheme(raw, { allowLoopbackHttp: this.allowLoopbackHttp });
  }

  private storage(): KV | null {
    return this.deps.storage === undefined ? defaultStorage() : this.deps.storage;
  }

  private readJson<T>(key: string): T | null {
    try {
      const raw = this.storage()?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private writeJson(key: string, value: unknown): void {
    try { this.storage()?.setItem(key, JSON.stringify(value)); } catch { /* storage off */ }
  }

  private persist(): void {
    const hosts = Object.keys(this.cache);
    if (hosts.length > MAX_CACHED) {
      for (const h of hosts.slice(0, hosts.length - MAX_CACHED)) {
        delete this.cache[h];
        this.docs.delete(h);
      }
    }
    this.writeJson(CACHE_KEY, this.cache);
  }
}

let instance: NetworkThemes | null = null;

// The app's NetworkThemes (main.tsx sets it up with discovery; a bare one
// otherwise, e.g. in component tests).
export function getNetworkThemes(): NetworkThemes {
  instance ??= new NetworkThemes();
  return instance;
}

export function setNetworkThemes(n: NetworkThemes | null): void {
  instance = n;
}
