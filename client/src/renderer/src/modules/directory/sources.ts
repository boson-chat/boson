import { defaultApiTransport, type ApiResponse, type ApiTransport } from '../../shared/http/transport';

// The network directories the client browses. The default one
// (directory.boson.chat, or VITE_DIRECTORY_URL) is always present and can
// only be switched off; the user can add others (a self-hosted stack's own
// directory, a community's) and remove them again. Each one is checked
// through its /.well-known/boson-directory.json before it is added, which
// also gives the name and operator shown on the source badge.
//
// Persisted in localStorage: the list is per device, like local servers.

export const DEFAULT_DIRECTORY_URL = 'https://directory.boson.chat';
const STORAGE_KEY = 'boson:directories:v1';
// Enough for any sensible setup, small enough that a browse fans out to a
// handful of requests at most.
export const MAX_DIRECTORIES = 8;

export interface DirectorySource {
  // The directory's origin (scheme://host[:port]); its identity.
  url: string;
  // Where its /v1 API lives (the well-known `api`, default: `url`).
  apiBase: string;
  name: string;
  operator?: string;
  contact?: string;
  // The auth issuer whose boson accounts it accepts for owner calls
  // (well-known `auth_issuer`). Registering a server there with our
  // sign-in is offered only when this is our own auth service.
  authIssuer?: string;
  isDefault: boolean;
  enabled: boolean;
}

// /.well-known/boson-directory.json.
export interface DirectoryWellKnown {
  name: string;
  api?: string;
  version?: string | number;
  operator?: string;
  contact?: string;
  federation?: boolean;
  auth_issuer?: string;
}

export interface DirectoryUrlOptions {
  // Dev builds: allow http:// to a loopback host (a local directory).
  allowLoopbackHttp?: boolean;
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// Parse what the user typed into a directory origin, or explain why not.
// https only (http to loopback in dev); no credentials, path, query or hash
// — a directory is identified by its origin alone.
export function normalizeDirectoryUrl(input: string, opts: DirectoryUrlOptions = {}): { url: string } | { error: string } {
  let raw = input.trim();
  if (!raw) return { error: 'Enter the directory’s address.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try { u = new URL(raw); } catch { return { error: 'That isn’t a valid address.' }; }
  if (u.protocol === 'http:') {
    if (!(opts.allowLoopbackHttp && isLoopbackHost(u.hostname))) {
      return { error: 'Directories must use https://.' };
    }
  } else if (u.protocol !== 'https:') {
    return { error: 'Directories must use https://.' };
  }
  if (!u.hostname) return { error: 'That isn’t a valid address.' };
  if (u.username || u.password) return { error: 'Leave out the username and password.' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    return { error: 'Use the directory’s address on its own, without a path.' };
  }
  return { url: u.origin };
}

// The well-known `api` may name the API root or its /v1; either way we keep
// the root, since every call adds /v1 itself.
function normalizeApiBase(api: string | undefined, origin: string, opts: DirectoryUrlOptions): string | null {
  if (!api) return origin;
  let u: URL;
  try { u = new URL(api, origin); } catch { return null; }
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && opts.allowLoopbackHttp && isLoopbackHost(u.hostname));
  if (!ok || u.username || u.password || u.search || u.hash) return null;
  const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return u.origin + path;
}

function str(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

export class DirectoryCheckError extends Error {}

// Fetch and validate a directory's well-known document; returns the source
// record it describes (enabled, not the default).
export async function fetchDirectoryInfo(
  url: string,
  opts: DirectoryUrlOptions & { transport?: ApiTransport } = {},
): Promise<DirectorySource> {
  // In the desktop app a directory not yet on the list is out of the
  // proxy's reach; the shell fetches just its well-known for us.
  const check = opts.transport ? undefined : shellBridge()?.checkDirectory;
  const transport = opts.transport ?? defaultApiTransport();
  let res: ApiResponse;
  try {
    res = check
      ? await check(url)
      : await transport({ method: 'GET', url: `${url}/.well-known/boson-directory.json`, headers: { Accept: 'application/json' } });
  } catch {
    throw new DirectoryCheckError('Couldn’t reach that directory.');
  }
  if (res.status === 0) throw new DirectoryCheckError('Couldn’t reach that directory.');
  if (!res.ok) throw new DirectoryCheckError(`That address isn’t a boson directory (HTTP ${res.status}).`);
  let doc: unknown;
  try { doc = JSON.parse(res.text); } catch { doc = null; }
  if (!doc || typeof doc !== 'object' || typeof (doc as DirectoryWellKnown).name !== 'string') {
    throw new DirectoryCheckError('That address isn’t a boson directory.');
  }
  const wk = doc as DirectoryWellKnown;
  const apiBase = normalizeApiBase(str(wk.api, 500), url, opts);
  if (!apiBase) throw new DirectoryCheckError('That directory advertises an API address we can’t use.');
  const authIssuer = str(wk.auth_issuer, 500);
  return {
    url,
    apiBase,
    name: str(wk.name, 80) ?? new URL(url).host,
    operator: str(wk.operator, 120),
    contact: str(wk.contact, 200),
    ...(authIssuer ? { authIssuer } : {}),
    isDefault: false,
    enabled: true,
  };
}

interface KVStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function localStore(): KVStorage | null {
  return (globalThis as { localStorage?: KVStorage }).localStorage ?? null;
}

interface Persisted {
  defaultEnabled: boolean;
  defaultInfo?: Partial<DirectorySource>;
  extra: DirectorySource[];
}

function isSource(v: unknown): v is DirectorySource {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.url === 'string' && typeof o.apiBase === 'string' && typeof o.name === 'string'
    && typeof o.enabled === 'boolean';
}

export interface DirectorySourcesOptions extends DirectoryUrlOptions {
  defaultUrl?: string;
  // Our auth service, to decide which directories accept our sign-in.
  authUrl?: string;
  transport?: ApiTransport;
  storage?: KVStorage | null;
}

type Listener = (list: ReadonlyArray<DirectorySource>) => void;

function originOf(u: string | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).origin; } catch { return null; }
}

export class DirectorySources {
  private readonly defaultUrl: string;
  private readonly opts: DirectorySourcesOptions;
  private readonly storage: KVStorage | null;
  private state: Persisted;
  private readonly listeners = new Set<Listener>();

  constructor(opts: DirectorySourcesOptions = {}) {
    this.opts = opts;
    const norm = normalizeDirectoryUrl(opts.defaultUrl ?? DEFAULT_DIRECTORY_URL, { allowLoopbackHttp: true });
    this.defaultUrl = 'url' in norm ? norm.url : DEFAULT_DIRECTORY_URL;
    this.storage = opts.storage === undefined ? localStore() : opts.storage;
    this.state = this.load();
  }

  private load(): Persisted {
    const empty: Persisted = { defaultEnabled: true, extra: [] };
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return empty;
      const p = JSON.parse(raw) as Partial<Persisted>;
      return {
        defaultEnabled: p.defaultEnabled !== false,
        defaultInfo: p.defaultInfo && typeof p.defaultInfo === 'object' ? p.defaultInfo : undefined,
        extra: Array.isArray(p.extra)
          ? p.extra.filter(isSource).filter((s) => s.url !== this.defaultUrl)
              .map((s) => ({ ...s, isDefault: false })).slice(0, MAX_DIRECTORIES - 1)
          : [],
      };
    } catch {
      return empty;
    }
  }

  private save(): void {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* best-effort */ }
    const list = this.list();
    for (const fn of this.listeners) fn(list);
  }

  get defaultSourceUrl(): string { return this.defaultUrl; }

  // Default first, then the user's own in the order added.
  list(): DirectorySource[] {
    const info = this.state.defaultInfo ?? {};
    const def: DirectorySource = {
      name: 'Boson directory',
      ...info,
      url: this.defaultUrl,
      apiBase: info.apiBase && originOf(info.apiBase) ? info.apiBase : this.defaultUrl,
      isDefault: true,
      enabled: this.state.defaultEnabled,
    };
    return [def, ...this.state.extra];
  }

  enabled(): DirectorySource[] {
    return this.list().filter((s) => s.enabled);
  }

  find(url: string): DirectorySource | undefined {
    return this.list().find((s) => s.url === url);
  }

  // Resolves once the desktop shell has the current list (see
  // syncDirectoriesToShell); browse waits on it so the first search isn't
  // refused by the proxy.
  private synced: Promise<void> = Promise.resolve();
  whenSynced(): Promise<void> { return this.synced; }
  setSynced(p: Promise<void>): void { this.synced = p.catch(() => {}); }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // Validate (well-known) and add a directory. Throws DirectoryCheckError
  // with a message for the settings form.
  async add(input: string): Promise<DirectorySource> {
    const norm = normalizeDirectoryUrl(input, this.opts);
    if ('error' in norm) throw new DirectoryCheckError(norm.error);
    if (norm.url === this.defaultUrl || this.state.extra.some((s) => s.url === norm.url)) {
      throw new DirectoryCheckError('That directory is already in your list.');
    }
    if (this.state.extra.length >= MAX_DIRECTORIES - 1) {
      throw new DirectoryCheckError(`You can add up to ${MAX_DIRECTORIES - 1} directories.`);
    }
    const src = await fetchDirectoryInfo(norm.url, this.opts);
    // Re-check after the await: a double submit mustn't add it twice.
    if (this.state.extra.some((s) => s.url === src.url)) return src;
    this.state = { ...this.state, extra: [...this.state.extra, src] };
    this.save();
    return src;
  }

  remove(url: string): void {
    if (url === this.defaultUrl) return;
    const extra = this.state.extra.filter((s) => s.url !== url);
    if (extra.length === this.state.extra.length) return;
    this.state = { ...this.state, extra };
    this.save();
  }

  setEnabled(url: string, enabled: boolean): void {
    if (url === this.defaultUrl) {
      if (this.state.defaultEnabled === enabled) return;
      this.state = { ...this.state, defaultEnabled: enabled };
    } else {
      if (!this.state.extra.some((s) => s.url === url && s.enabled !== enabled)) return;
      this.state = { ...this.state, extra: this.state.extra.map((s) => (s.url === url ? { ...s, enabled } : s)) };
    }
    this.save();
  }

  // Refresh the default directory's name/operator (and API base) from its
  // well-known. Best-effort: the built-in defaults work without it.
  async refreshDefault(): Promise<void> {
    try {
      const info = await fetchDirectoryInfo(this.defaultUrl, { ...this.opts, allowLoopbackHttp: true });
      const { url: _u, isDefault: _d, enabled: _e, ...rest } = info;
      this.state = { ...this.state, defaultInfo: rest };
      this.save();
    } catch { /* keep what we have */ }
  }

  // Whether owner calls (register, verify, edit) with our boson sign-in may
  // go to this directory: the default always; another only when it says it
  // accepts accounts from our auth service. Sending our access token to any
  // other directory would hand it to a third party.
  acceptsOurAccounts(src: DirectorySource): boolean {
    if (src.isDefault) return true;
    const ours = originOf(this.opts.authUrl);
    return !!ours && originOf(src.authIssuer) === ours;
  }

  hostable(): DirectorySource[] {
    return this.list().filter((s) => this.acceptsOurAccounts(s));
  }
}

let singleton: DirectorySources | null = null;

// The app-wide list (main.tsx configures it at startup; tests and the
// settings screen read it).
export function getDirectorySources(): DirectorySources {
  if (!singleton) singleton = new DirectorySources();
  return singleton;
}

export function configureDirectorySources(opts: DirectorySourcesOptions): DirectorySources {
  singleton = new DirectorySources(opts);
  return singleton;
}

interface ShellApiBridge {
  setDirectories?: (entries: ShellDirectoryEntry[]) => Promise<unknown>;
  checkDirectory?: (url: string) => Promise<ApiResponse>;
}

function shellBridge(): ShellApiBridge | undefined {
  return typeof window !== 'undefined' ? (window as { bosonApi?: ShellApiBridge }).bosonApi : undefined;
}

// One directory for the desktop proxy (desktop/directories.go). The shell
// re-validates each (https, exact origin, no private addresses) and allows
// only credential-free GETs there — unless it is the build's own default
// directory, or `owner` is set and the shell's own check of the well-known
// finds our auth service as its auth_issuer.
export interface ShellDirectoryEntry {
  url: string;
  api?: string;
  owner?: boolean;
}

export function shellEntries(sources: DirectorySources): ShellDirectoryEntry[] {
  return sources.list().filter((s) => s.enabled || s.isDefault).map((s) => {
    const api = originOf(s.apiBase);
    return {
      url: s.url,
      ...(api && api !== s.url ? { api } : {}),
      ...(sources.acceptsOurAccounts(s) ? { owner: true } : {}),
    };
  });
}

export function syncDirectoriesToShell(sources: DirectorySources): void {
  const set = shellBridge()?.setDirectories;
  if (!set) return;
  const push = (): void => {
    sources.setSynced(Promise.resolve(set(shellEntries(sources))).then(() => undefined));
  };
  push();
  sources.subscribe(push);
}
