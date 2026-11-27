// "Sign in to <network>": accounts on self-hosted boson networks, next to the
// app's own account (boson.chat's; on a self-hosted network's web client,
// that network's: home-network.ts).
//
// A network that runs the boson stack names its auth service in
// https://<domain>/.well-known/boson.json. The desktop shell looks that up
// (desktop/netauth.go) for networks the user adds or joins, and lets its API
// proxy reach that auth origin. Here each auth service gets its own
// AuthService — its own session, refresh token (in the keychain under its
// own key) and single-flight refresh — so tokens of one service never meet
// another's: the network's IRC login (SASL OAUTHBEARER), voice and the like
// use that network's session, everything tied to the app's own account
// (profile, identity key, sync, nick claims, presence) keeps using the main
// account. The proxy
// enforces the same split (apiproxy.go: tokenRealmOK).
//
// The app's own networks (auth == the app's auth) use the main account.

import { AuthService, guestAccessAllowed, type AuthConfig, type Session } from '../auth/auth.service';
import type { SecureStorage } from '../../shared/secure-storage';
import type { ApiTransport } from '../../shared/http/transport';
import {
  acceptsFederation, cleanFederation, federatedSignIn, identityOf, issuesAssertions,
  type FederationInfo, type HomeAccount,
} from './federation';
import { getHomeNetwork } from './home-network';

// window.bosonNetAuth (platform/wails.ts → desktop/netauth.go).
export interface NetAuthBridge {
  discover(host: string, refresh: boolean): Promise<{
    host: string;
    authUrl?: string;
    directoryUrl?: string;
    // The network's theme document (boson.json branding), with or
    // without accounts. Absent on shells that predate it.
    brandingUrl?: string;
    // The network's federated sign-in block (with its domain). Absent on
    // shells that predate it, and for networks without federation.
    federation?: unknown;
    main: boolean;
    error?: string;
  }>;
  // "Use another server" (desktop/netauth.go Resolve): the network the
  // user typed — its boson.json, auth service (validated and made
  // reachable) and IRC server. Absent on shells that predate it.
  resolve?(address: string): Promise<ResolvedNetwork>;
}

// Resolve's answer. error: '' or one of invalid | unreachable |
// no-boson-json | no-accounts | untrusted | no-irc.
export interface ResolvedNetwork {
  host: string;
  domain?: string;
  irc?: { host: string; port: number; tls: boolean };
  authUrl?: string;
  directoryUrl?: string;
  brandingUrl?: string;
  federation?: unknown;
  main: boolean;
  error?: string;
  detail?: string;
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
  // Federated sign-in (boson.json federation), when the network has it.
  federation?: FederationInfo;
}

// The federation block a shell handed over, re-checked (dev shells allow
// loopback http).
function federationOf(raw: unknown, domainFallback: string): FederationInfo | undefined {
  const f = cleanFederation(raw, true);
  if (!f) return undefined;
  return { ...f, domain: f.domain || domainFallback };
}

function domainOfHost(host: string): string {
  const labels = host.toLowerCase().split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : host.toLowerCase();
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
  // Whether the user is in app-wide guest mode (no main account).
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
  // boson.json branding URLs by host (network themes), as discovered.
  private brandings: Record<string, string> = {};
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
    if (!refresh && host in this.links) {
      // Known — but its saved session may still be loading (the link is
      // recorded first): wait for it, so a connect sees the session.
      const known = this.links[host] ?? null;
      return known && !known.main ? this.ensureService(known.authUrl).then(() => known) : Promise.resolve(known);
    }
    const running = this.discovering.get(host);
    if (running) return running;
    const p = (async () => {
      let link: NetworkLink | null = null;
      try {
        const r = await withTimeout(bridge.discover(host, refresh), this.opts.discoverTimeoutMs ?? 5000);
        this.recordBranding(host, r?.brandingUrl);
        if (r?.authUrl) {
          const federation = federationOf(r.federation, domainOfHost(host));
          link = {
            host, authUrl: normalizeAuthBase(r.authUrl), main: !!r.main || this.isMain(r.authUrl),
            ...(r.directoryUrl ? { directoryUrl: r.directoryUrl } : {}),
            ...(federation ? { federation } : {}),
          };
        }
      } catch {
        link = null;
      }
      await this.setLink(host, link);
      return link;
    })().finally(() => this.discovering.delete(host));
    this.discovering.set(host, p);
    return p;
  }

  // "Use another server": looks up the network the user typed (its
  // boson.json, validated like discover's). An answer with an auth service
  // and an IRC server becomes that IRC host's link, as if discovered.
  async resolve(address: string): Promise<ResolvedNetwork | null> {
    const bridge = this.bridge();
    if (!bridge?.resolve) return null;
    const r = await withTimeout(bridge.resolve(address), (this.opts.discoverTimeoutMs ?? 5000) * 2);
    if (r.irc?.host) this.recordBranding(hostKey(r.irc.host), r.brandingUrl);
    if (r.authUrl && r.irc?.host && !r.error) {
      const host = hostKey(r.irc.host);
      const federation = federationOf(r.federation, r.domain || domainOfHost(host));
      const link: NetworkLink = {
        host,
        authUrl: normalizeAuthBase(r.authUrl),
        main: !!r.main || this.isMain(r.authUrl),
        ...(r.directoryUrl ? { directoryUrl: r.directoryUrl } : {}),
        ...(federation ? { federation } : {}),
      };
      await this.setLink(host, link);
    }
    return r;
  }

  // Whether this shell can look up a typed server address.
  get canResolve(): boolean {
    return typeof this.bridge()?.resolve === 'function';
  }

  private async setLink(host: string, link: NetworkLink | null): Promise<void> {
    this.links = { ...this.links, [host]: link };
    if (link && !link.main) {
      this.remember(link);
      await this.ensureService(link.authUrl);
      this.linkListeners.forEach((fn) => fn(link));
    }
    this.emit();
  }

  private recordBranding(host: string, url: string | undefined): void {
    if (url) this.brandings[host] = url;
    else delete this.brandings[host];
  }

  // The network's theme document URL from its boson.json (undefined:
  // none, or not discovered yet).
  brandingUrlFor(rawHost: string): string | undefined {
    return this.brandings[hostKey(rawHost)];
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

  // The network's session (main networks: the main account, unless in
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

  // ---- federated sign-in ----

  // The app's own account's federation block (its boson.json), looked up
  // once per run.
  private mainFed: Promise<FederationInfo | null> | null = null;

  private mainFederation(): Promise<FederationInfo | null> {
    const known = Object.values(this.links).find((l) => l?.main && l.federation)?.federation;
    if (known) return Promise.resolve(known);
    const bridge = this.bridge();
    if (!bridge) return Promise.resolve(null);
    if (!this.mainFed) {
      const domain = mainDomainOf(this.main);
      // Discovery looks a host up at its parent domain (irc.boson.chat →
      // boson.chat): a deeper domain (boson.example.org, a self-hosted web
      // client's) is asked for by its auth host (auth.boson.example.org).
      const query = domain.split('.').length > 2 ? hostOf(this.main).replace(/:\d+$/, '').toLowerCase() : domain;
      this.mainFed = withTimeout(bridge.discover(query, false), this.opts.discoverTimeoutMs ?? 5000)
        .then((r) => (r?.main || (r?.authUrl && this.isMain(r.authUrl)) ? federationOf(r.federation, domain) ?? null : null))
        .catch(() => null);
      // A failed lookup is tried again next time.
      void this.mainFed.then((f) => { if (!f) this.mainFed = null; });
    }
    return this.mainFed;
  }

  // The accounts the user is signed in to that can vouch for them on
  // remote (one "Continue as …" each): the main account and network
  // accounts whose server issues assertions. Never remote's own, nor
  // accounts that are themselves federated. [] when remote doesn't take
  // accounts from elsewhere.
  async homeAccounts(remote: NetworkLink): Promise<HomeAccount[]> {
    if (!acceptsFederation(remote.federation, remote.authUrl)) return [];
    const remoteKey = normalizeAuthBase(remote.authUrl);
    const out: HomeAccount[] = [];
    const add = (authUrl: string, main: boolean, fed: FederationInfo | undefined | null, session: Session | null, name: string): void => {
      const key = normalizeAuthBase(authUrl);
      if (key === remoteKey || !session || session.federated || !fed?.domain) return;
      if (!issuesAssertions(fed, key)) return;
      // Its issuer is what the remote checks the assertion against: it
      // has to be this auth service.
      if (fed.issuer && hostOf(fed.issuer) !== hostOf(key)) return;
      const username = session.user.username;
      if (!username) return;
      const identity = identityOf(username, fed.domain);
      if (out.some((h) => h.identity === identity)) return;
      out.push({ authUrl: key, main, domain: fed.domain, username, identity, name, federation: fed });
    };
    if (!this.opts.isGuest?.()) {
      const s = this.opts.mainAuth.getState().session;
      if (s) add(this.main, true, await this.mainFederation(), s, getHomeNetwork().name);
    }
    for (const k of this.known) {
      const link = k.hosts.map((h) => this.links[hostKey(h)]).find((l) => l && normalizeAuthBase(l.authUrl) === normalizeAuthBase(k.authUrl));
      if (!link) continue;
      add(k.authUrl, false, link.federation, this.sessionFor(link), this.nameFor(k.authUrl));
    }
    return out;
  }

  // "Continue as alice@boson.chat" on remote: an assertion from the home
  // account, signed in on remote's own auth service. Throws
  // FederationError.
  async signInFederated(remote: NetworkLink, home: HomeAccount): Promise<Session> {
    const remoteKey = normalizeAuthBase(remote.authUrl);
    const homeAuth = home.main ? this.opts.mainAuth : this.service(home.authUrl);
    const remoteAuth = this.service(remoteKey);
    await this.ensureService(remoteKey);
    const session = await federatedSignIn({
      home, homeAuth, remote: remote.federation!, remoteAuthUrl: remoteKey, remoteAuth,
    });
    this.setGuestChosen(remote.host, false);
    return session;
  }

  // The federated accounts made from the account at authUrl (Settings says
  // they stay signed in when it signs out).
  linkedTo(authUrl: string): Array<{ authUrl: string; name: string; session: Session }> {
    const key = normalizeAuthBase(authUrl);
    return this.known.flatMap((k) => {
      const s = this.sessions[normalizeAuthBase(k.authUrl)];
      return s?.federated && normalizeAuthBase(s.federated.homeAuthUrl) === key
        ? [{ authUrl: normalizeAuthBase(k.authUrl), name: this.nameFor(k.authUrl), session: s }]
        : [];
    });
  }

  // Whether the account a federated session came from is still signed in
  // here.
  homeSignedIn(session: Session): boolean {
    const f = session.federated;
    if (!f) return false;
    const key = normalizeAuthBase(f.homeAuthUrl);
    if (key === this.main) return !this.opts.isGuest?.() && !!this.opts.mainAuth.getState().session;
    return !!(this.sessions[key] ?? null);
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

  // Names a network's auth service until it says its own name (its
  // /v1/config site_name wins whenever it does).
  nameIfUnnamed(authUrl: string, name: string): void {
    const key = normalizeAuthBase(authUrl);
    const at = this.known.findIndex((k) => normalizeAuthBase(k.authUrl) === key);
    if (at < 0 || this.known[at]!.name) return;
    this.known = this.known.map((x, i) => (i === at ? { ...x, name: name.slice(0, 80) } : x));
    this.saveKnown();
    this.emit();
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

  // Sign-out: sign out of every network account (each revokes its refresh
  // token server-side), then forget the networks, the guest choices and any
  // sign-in prompt. Discovery (which hosts use which auth service) is public
  // and stays cached.
  async clearForSignOut(): Promise<void> {
    const keys = new Set([...this.services.keys(), ...this.known.map((k) => normalizeAuthBase(k.authUrl))]);
    keys.delete(this.main);
    await Promise.all(Array.from(keys).map((k) => this.service(k).signOut().catch(() => {})));
    this.pending?.resolve('cancel');
    this.pending = null;
    for (const q of this.queue.splice(0)) q.resolve('cancel');
    this.unsub.forEach((off) => off());
    this.unsub.clear();
    this.services.clear();
    this.inits.clear();
    this.configs.clear();
    this.sessions = {};
    this.known = [];
    try {
      this.local()?.removeItem(KNOWN_KEY);
      this.local()?.removeItem(GUEST_KEY);
    } catch { /* storage off */ }
    this.emit();
  }

  // The remembered networks' auth URLs (the sign-out wipe names their
  // keychain sessions when the store can't remove by prefix).
  knownAuthUrls(): string[] {
    return this.known.map((k) => normalizeAuthBase(k.authUrl));
  }

  dispose(): void {
    this.unsub.forEach((off) => off());
    this.unsub.clear();
  }
}

// boson.chat for https://auth.boson.chat (boson.example.org for
// https://auth.boson.example.org): where the app's own boson.json is.
export function mainDomainOf(authUrl: string): string {
  const host = hostOf(authUrl).replace(/:\d+$/, '').toLowerCase();
  return host.startsWith('auth.') ? host.slice(5) : host;
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
