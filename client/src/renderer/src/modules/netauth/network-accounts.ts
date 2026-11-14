// "Sign in to <network>": accounts on self-hosted boson networks, next to the
// app's own (boson.chat) account.
//
// A network that runs the boson stack names its auth service in
// https://<domain>/.well-known/boson.json. The desktop shell looks that up
// (desktop/netauth.go) for networks the user adds or joins, and lets its API
// proxy reach that auth origin. Here each auth service gets its own
// AuthService — its own session, refresh token (in the keychain under its
// own key) and single-flight refresh — so tokens of one service never meet
// another's: the network's IRC login (SASL OAUTHBEARER), voice and the like
// use that network's session, everything boson.chat-only (profile, identity
// key, sync, nick claims, presence) keeps using the main account. The proxy
// enforces the same split (apiproxy.go: tokenRealmOK).
//
// boson.chat-hosted networks (auth == the app's auth) use the main account.

import { AuthService, guestAccessAllowed, type AuthConfig, type Session } from '../auth/auth.service';
import type { SecureStorage } from '../../shared/secure-storage';
import type { ApiTransport } from '../../shared/http/transport';

// window.bosonNetAuth (platform/wails.ts → desktop/netauth.go).
export interface NetAuthBridge {
  discover(host: string, refresh: boolean): Promise<{
    host: string;
    authUrl?: string;
    directoryUrl?: string;
    main: boolean;
    error?: string;
  }>;
}

export function netAuthBridge(): NetAuthBridge | null {
  return (globalThis as { bosonNetAuth?: NetAuthBridge }).bosonNetAuth ?? null;
}

// What a network's discovery said: its auth service (null: none — a plain
// IRC network) and whether that's the app's own.
export interface NetworkLink {
  host: string;
  authUrl: string;
  main: boolean;
  directoryUrl?: string;
}

// A remembered network auth service (non-secret, localStorage): which hosts
// use it and what it's called, so Settings can list it and its session is
// restored at launch.
export interface KnownAuth {
  authUrl: string;
  name: string;
  hosts: string[];
}

export type SignInOutcome = 'signed-in' | 'guest' | 'cancel';

// Why the sign-in dialog is up.
//   connect  — connecting to a network that has accounts (guest is offered
//              when the network allows it)
//   required — the IRC server refused a guest (or the network says no guests)
//   expired  — the network's session ended (refresh refused) or its token
//              was refused at IRC login
//   manage   — opened from the server header or Settings
export type SignInReason = 'connect' | 'required' | 'expired' | 'manage';

export interface SignInPrompt {
  link: NetworkLink;
  // The server's display name (the dialog prefers the network's own name).
  serverName: string;
  reason: SignInReason;
  // Offer "Continue as guest" (subject to the network's guest_access).
  allowGuest: boolean;
}

interface PendingPrompt extends SignInPrompt {
  resolve: (r: SignInOutcome) => void;
}

export interface NetworkAccountsSnapshot {
  known: ReadonlyArray<KnownAuth>;
  // Sessions by auth URL (networks only; the main account isn't here).
  sessions: Readonly<Record<string, Session | null>>;
  // Discovery by host.
  links: Readonly<Record<string, NetworkLink | null>>;
  prompt: SignInPrompt | null;
}

export interface NetworkAccountsOptions {
  mainAuthUrl: string;
  mainAuth: AuthService;
  // Whether the user is in app-wide guest mode (no boson.chat account).
  isGuest?: () => boolean;
  storage?: SecureStorage;
  transport?: ApiTransport;
  bridge?: NetAuthBridge | null;
  local?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  // How long discovery may hold up a connect.
  discoverTimeoutMs?: number;
}

const KNOWN_KEY = 'boson.netauth.known';
const GUEST_KEY = 'boson.netauth.guest';
export const SESSION_KEY_PREFIX = 'boson.netauth.session:';
const CONFIG_TTL_MS = 5 * 60_000;

export function normalizeAuthBase(u: string): string {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return u.replace(/\/+$/, '');
  }
}

// The keychain key a network's session is kept under.
export function sessionKeyFor(authUrl: string): string {
  return SESSION_KEY_PREFIX + normalizeAuthBase(authUrl);
}

function hostKey(h: string): string {
  return h.trim().toLowerCase();
}

export class NetworkAccounts {
  private readonly opts: NetworkAccountsOptions;
  private readonly main: string;
  private readonly services = new Map<string, AuthService>();
  private readonly unsub = new Map<string, () => void>();
  private readonly inits = new Map<string, Promise<void>>();
  private readonly configs = new Map<string, { at: number; cfg: Promise<AuthConfig> }>();
  private readonly discovering = new Map<string, Promise<NetworkLink | null>>();
  private links: Record<string, NetworkLink | null> = {};
  private sessions: Record<string, Session | null> = {};
  private known: KnownAuth[];
  private pending: PendingPrompt | null = null;
  private readonly queue: PendingPrompt[] = [];
  private readonly listeners = new Set<(s: NetworkAccountsSnapshot) => void>();
  private readonly linkListeners = new Set<(link: NetworkLink) => void>();
  private snap: NetworkAccountsSnapshot;

  constructor(opts: NetworkAccountsOptions) {
    this.opts = opts;
    this.main = normalizeAuthBase(opts.mainAuthUrl);
    this.known = this.loadKnown();
    this.snap = this.build();
  }

  // ---- state ----

  getSnapshot(): NetworkAccountsSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: NetworkAccountsSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // A network's auth service became reachable (voice re-checks it).
  onLinked(fn: (link: NetworkLink) => void): () => void {
    this.linkListeners.add(fn);
    return () => { this.linkListeners.delete(fn); };
  }

  private build(): NetworkAccountsSnapshot {
    return {
      known: this.known,
      sessions: { ...this.sessions },
      links: { ...this.links },
      prompt: this.pending ? { link: this.pending.link, serverName: this.pending.serverName, reason: this.pending.reason, allowGuest: this.pending.allowGuest } : null,
    };
  }

  private emit(): void {
    this.snap = this.build();
    this.listeners.forEach((fn) => fn(this.snap));
  }

  // Whether this app can do network sign-in (the desktop shell).
  get supported(): boolean {
    return this.bridge() !== null;
  }

  private bridge(): NetAuthBridge | null {
    return this.opts.bridge === undefined ? netAuthBridge() : this.opts.bridge;
  }

  isMain(authUrl: string): boolean {
    return normalizeAuthBase(authUrl) === this.main;
  }

  // ---- launch ----

  // Re-discovers the remembered networks (the shell's allowlist is per run)
  // and restores their sessions.
  async init(): Promise<void> {
    await Promise.all(this.known.map(async (k) => {
      const host = k.hosts[0];
      if (!host) return;
      const link = await this.discover(host).catch(() => null);
      if (link && normalizeAuthBase(link.authUrl) === normalizeAuthBase(k.authUrl)) await this.ensureService(k.authUrl);
    }));
  }

  // ---- discovery ----

  // Which auth service host's network uses (null: none, or no shell).
  // Cached per run; the shell caches the lookup for a day.
  discover(rawHost: string, refresh = false): Promise<NetworkLink | null> {
    const host = hostKey(rawHost);
    const bridge = this.bridge();
    if (!bridge || !host) return Promise.resolve(null);
    if (!refresh && host in this.links) return Promise.resolve(this.links[host] ?? null);
    const running = this.discovering.get(host);
    if (running) return running;
    const p = (async () => {
      let link: NetworkLink | null = null;
      try {
        const r = await withTimeout(bridge.discover(host, refresh), this.opts.discoverTimeoutMs ?? 8000);
        if (r?.authUrl) {
          link = { host, authUrl: normalizeAuthBase(r.authUrl), main: !!r.main || this.isMain(r.authUrl), ...(r.directoryUrl ? { directoryUrl: r.directoryUrl } : {}) };
        }
      } catch {
        link = null;
      }
      this.links = { ...this.links, [host]: link };
      if (link && !link.main) {
        this.remember(link);
        await this.ensureService(link.authUrl);
        this.linkListeners.forEach((fn) => fn(link!));
      }
      this.emit();
      return link;
    })().finally(() => this.discovering.delete(host));
    this.discovering.set(host, p);
    return p;
  }

  linkFor(rawHost: string): NetworkLink | null {
    return this.links[hostKey(rawHost)] ?? null;
  }

  // ---- per-network auth services ----

  // The AuthService for a network's auth URL (never the main one's: use
  // mainAuth for that). Created on first use; its saved session restored.
  service(authUrl: string): AuthService {
    const key = normalizeAuthBase(authUrl);
    if (key === this.main) return this.opts.mainAuth;
    let svc = this.services.get(key);
    if (!svc) {
      svc = new AuthService(key, {
        storage: this.opts.storage,
        storageKey: sessionKeyFor(key),
        ...(this.opts.transport ? { transport: this.opts.transport } : {}),
      });
      this.services.set(key, svc);
      this.unsub.set(key, svc.subscribe((st) => {
        if (st.loading) return;
        const had = this.sessions[key];
        this.sessions = { ...this.sessions, [key]: st.session };
        if (had !== st.session) this.emit();
      }));
    }
    return svc;
  }

  private ensureService(authUrl: string): Promise<void> {
    const key = normalizeAuthBase(authUrl);
    if (key === this.main) return Promise.resolve();
    let p = this.inits.get(key);
    if (!p) {
      p = this.service(key).init().catch(() => {});
      this.inits.set(key, p);
    }
    return p;
  }

  // The network's session (main networks: the boson.chat account, unless in
  // guest mode).
  sessionFor(link: NetworkLink): Session | null {
    if (link.main) return this.opts.isGuest?.() ? null : this.opts.mainAuth.getState().session;
    return this.sessions[normalizeAuthBase(link.authUrl)] ?? this.service(link.authUrl).getState().session;
  }

  // A fresh access token of the network's own auth service for its IRC
  // login, or null when signed out there.
  async ircToken(link: NetworkLink): Promise<string | null> {
    if (!this.sessionFor(link)) return null;
    const svc = link.main ? this.opts.mainAuth : this.service(link.authUrl);
    await (link.main ? Promise.resolve() : this.ensureService(link.authUrl));
    return svc.getToken();
  }

  // The network's public settings (registration, SSO providers,
  // guest_access, its name), cached for a few minutes.
  config(authUrl: string, fresh = false): Promise<AuthConfig> {
    const key = normalizeAuthBase(authUrl);
    const hit = this.configs.get(key);
    if (hit && !fresh && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
    const svc = key === this.main ? this.opts.mainAuth : this.service(key);
    const cfg = svc.config();
    this.configs.set(key, { at: Date.now(), cfg });
    cfg.then((c) => this.rename(key, c), () => this.configs.delete(key));
    return cfg;
  }

  async guestAllowed(link: NetworkLink): Promise<boolean> {
    try {
      return guestAccessAllowed(await this.config(link.authUrl));
    } catch {
      return true; // unreachable: let the IRC server decide
    }
  }

  async signOut(authUrl: string): Promise<void> {
    const key = normalizeAuthBase(authUrl);
    if (key === this.main) return;
    await this.service(key).signOut();
  }

  // Forgets a network entirely (Settings → Accounts → Remove).
  async forget(authUrl: string): Promise<void> {
    const key = normalizeAuthBase(authUrl);
    await this.signOut(key);
    this.known = this.known.filter((k) => normalizeAuthBase(k.authUrl) !== key);
    this.saveKnown();
    this.emit();
  }

  // The display name for a network's auth (its own name when it gives one).
  nameFor(authUrl: string, fallback = ''): string {
    const key = normalizeAuthBase(authUrl);
    const k = this.known.find((x) => normalizeAuthBase(x.authUrl) === key);
    return k?.name || fallback || hostOf(key);
  }

  // ---- guest choice ----

  guestChosen(rawHost: string): boolean {
    return this.loadGuest().includes(hostKey(rawHost));
  }

  setGuestChosen(rawHost: string, on: boolean): void {
    const host = hostKey(rawHost);
    const set = new Set(this.loadGuest());
    if (on) set.add(host); else set.delete(host);
    try { this.local()?.setItem(GUEST_KEY, JSON.stringify([...set])); } catch { /* storage off */ }
  }

  // ---- the sign-in dialog ----

  // Shows the network's sign-in dialog (one at a time; others queue) and
  // resolves with what the user did.
  promptSignIn(p: SignInPrompt): Promise<SignInOutcome> {
    // Until the network says its own name, call it what the user's server
    // list does.
    if (!p.link.main && p.serverName) this.nameIfUnnamed(p.link.authUrl, p.serverName);
    return new Promise((resolve) => {
      const entry: PendingPrompt = { ...p, resolve };
      const same = this.pending && this.pending.link.authUrl === p.link.authUrl && this.pending.link.host === p.link.host;
      if (same) {
        // Already asking about this network: share the answer.
        const prev = this.pending!.resolve;
        this.pending!.resolve = (r) => { prev(r); resolve(r); };
        return;
      }
      if (this.pending) {
        this.queue.push(entry);
        return;
      }
      this.pending = entry;
      this.emit();
    });
  }

  // The dialog's answer.
  resolvePrompt(outcome: SignInOutcome): void {
    const p = this.pending;
    if (!p) return;
    if (outcome === 'guest') this.setGuestChosen(p.link.host, true);
    if (outcome === 'signed-in') this.setGuestChosen(p.link.host, false);
    this.pending = this.queue.shift() ?? null;
    this.emit();
    p.resolve(outcome);
  }

  // ---- persistence ----

  private remember(link: NetworkLink): void {
    const key = normalizeAuthBase(link.authUrl);
    const at = this.known.findIndex((k) => normalizeAuthBase(k.authUrl) === key);
    if (at >= 0) {
      const k = this.known[at]!;
      if (k.hosts.includes(link.host)) return;
      this.known = this.known.map((x, i) => (i === at ? { ...x, hosts: [...x.hosts, link.host].slice(-8) } : x));
    } else {
      this.known = [...this.known, { authUrl: key, name: '', hosts: [link.host] }].slice(-32);
    }
    this.saveKnown();
  }

  private rename(key: string, c: AuthConfig): void {
    const name = (c.site_name || c.network_name || '').trim().slice(0, 80);
    if (!name) return;
    const at = this.known.findIndex((k) => normalizeAuthBase(k.authUrl) === key);
    if (at < 0 || this.known[at]!.name === name) return;
    this.known = this.known.map((x, i) => (i === at ? { ...x, name } : x));
    this.saveKnown();
    this.emit();
  }

  private nameIfUnnamed(authUrl: string, name: string): void {
    const key = normalizeAuthBase(authUrl);
    const at = this.known.findIndex((k) => normalizeAuthBase(k.authUrl) === key);
    if (at < 0 || this.known[at]!.name) return;
    this.known = this.known.map((x, i) => (i === at ? { ...x, name: name.slice(0, 80) } : x));
    this.saveKnown();
  }

  private local(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
    if (this.opts.local !== undefined) return this.opts.local;
    try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
  }

  private loadKnown(): KnownAuth[] {
    try {
      const raw = this.local()?.getItem(KNOWN_KEY);
      const v = raw ? JSON.parse(raw) as unknown : [];
      if (!Array.isArray(v)) return [];
      return v.filter((k): k is KnownAuth => !!k && typeof k.authUrl === 'string' && Array.isArray(k.hosts))
        .map((k) => ({ authUrl: normalizeAuthBase(k.authUrl), name: typeof k.name === 'string' ? k.name : '', hosts: k.hosts.filter((h) => typeof h === 'string') }))
        .filter((k) => normalizeAuthBase(k.authUrl) !== this.main);
    } catch {
      return [];
    }
  }

  private saveKnown(): void {
    try { this.local()?.setItem(KNOWN_KEY, JSON.stringify(this.known)); } catch { /* storage off */ }
  }

  private loadGuest(): string[] {
    try {
      const v = JSON.parse(this.local()?.getItem(GUEST_KEY) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.unsub.forEach((off) => off());
    this.unsub.clear();
  }
}

export function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

let instance: NetworkAccounts | null = null;

export function getNetworkAccounts(): NetworkAccounts | null {
  return instance;
}

export function setNetworkAccounts(a: NetworkAccounts | null): void {
  instance?.dispose();
  instance = a;
}
