// Push notifications, per server (docs/push.md §3): finds out whether each
// connected server offers push (availability.ts), keeps this device
// subscribed there — `WEBPUSH REGISTER` on every connect, which also renews
// the server's expiry — and takes the subscription down again on sign-out,
// on leaving the server and when the person turns it off (§3.4:
// `WEBPUSH UNREGISTER`, then the browser subscription or relay mailbox goes,
// even while the server is unreachable).
//
// The platform part (where an endpoint comes from, who decrypts and shows
// the notification) is window.bosonPush (push.types.ts).
import { pushStatus, shouldRegister, type PushFacts, type PushStatus } from './availability';
import { cleanPrefs, type PushPrefs } from './filter';
import { PushError, pushBridge, type PushBridge, type PushPermission } from './push.types';
import type { EngineState, IrcEvent } from '../engine/engine.types';
import {
  getNotificationSettings, notificationLevelsSnapshot, onNotificationSettingsChange,
} from '../ui/notifications.store';
import { registerForSignOut } from '../signout/sign-out';

export const PUSH_STORAGE_KEY = 'boson:push:v1';

// What a connection gives the manager (DirectoryBloc wires it up).
export interface PushSession {
  onEvent(fn: (e: IrcEvent) => void): () => void;
  onState(fn: (s: EngineState, error?: string) => void): () => void;
  state(): EngineState;
  raw(line: string): void;
}

export interface PushServer {
  serverId: string;
  serverName: string;
  host: string;
  boson: boolean;
  viaBouncer: boolean;
  signedIn: boolean;
  session: PushSession;
}

export interface PushRow {
  serverId: string;
  serverName: string;
  status: PushStatus;
  // Phones: the relay pushes go through (shown with the privacy note).
  relay?: string;
}

interface Saved {
  off?: true;
  endpoint?: string;
}

interface Live {
  server: PushServer;
  facts: PushFacts;
  connected: boolean;
  // The endpoint a REGISTER is out for.
  pendingEndpoint: string | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  vapidTimer: ReturnType<typeof setTimeout> | null;
  // Bumped on every (re)connect and detach: a slow subscribe from an earlier
  // one is dropped.
  epoch: number;
  stops: Array<() => void>;
}

interface LocalStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface PushManagerOptions {
  bridge?: PushBridge | null;
  storage?: LocalStore | null;
  // How long to wait for the server's answer to REGISTER (it first sends a
  // test push to the endpoint), and for VAPID= after the welcome.
  registerTimeoutMs?: number;
  vapidWaitMs?: number;
  prefs?: () => PushPrefs;
}

const isEndOfBurst = (k: string): boolean => k === '376' || k === '422';

export function currentPushPrefs(): PushPrefs {
  const s = getNotificationSettings();
  const lv = notificationLevelsSnapshot();
  return cleanPrefs({ v: 1, enabled: s.enabled, mentions: s.mentions, directMessages: s.directMessages, servers: lv.servers, levels: lv.levels });
}

export class PushManager {
  private readonly bridge: PushBridge | null;
  private readonly storage: LocalStore | null;
  private readonly registerTimeoutMs: number;
  private readonly vapidWaitMs: number;
  private readonly prefs: () => PushPrefs;
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<() => void>();
  private readonly openers = new Set<(serverId: string, conversation: string) => void>();
  private readonly relays = new Map<string, Promise<string>>();
  private permission: PushPermission = 'default';
  private unsupported: string | null = null;
  private started = false;
  private stops: Array<() => void> = [];

  constructor(opts: PushManagerOptions = {}) {
    this.bridge = opts.bridge === undefined ? pushBridge() : opts.bridge;
    this.storage = opts.storage === undefined ? ((globalThis as { localStorage?: LocalStore }).localStorage ?? null) : opts.storage;
    this.registerTimeoutMs = opts.registerTimeoutMs ?? 30_000;
    this.vapidWaitMs = opts.vapidWaitMs ?? 5_000;
    this.prefs = opts.prefs ?? currentPushPrefs;
  }

  get platform(): PushBridge['platform'] | null { return this.bridge?.platform ?? null; }

  // Reads the platform's state and mirrors the settings. Idempotent.
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const b = this.bridge;
    if (!b) return;
    this.stops.push(b.onOpen((s, c) => this.opened(s, c)));
    this.stops.push(onNotificationSettingsChange(() => { void b.syncPrefs(this.prefs()).catch(() => {}); }));
    try { this.unsupported = await b.supported(); } catch { this.unsupported = 'Push isn’t available here.'; }
    try { this.permission = await b.permission(); } catch { /* default */ }
    void b.syncPrefs(this.prefs()).catch(() => {});
    for (const l of this.live.values()) l.facts = { ...l.facts, unsupported: this.unsupported, permission: this.permission };
    this.emit();
    for (const id of this.live.keys()) this.evaluate(id);
    const first = await b.consumeOpen().catch(() => null);
    if (first) this.opened(first.serverId, first.conversation);
  }

  dispose(): void {
    for (const s of this.stops) s();
    this.stops = [];
    for (const id of Array.from(this.live.keys())) this.detach(id);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // A push notification opened (tapped / clicked): the buffer to show.
  onOpen(fn: (serverId: string, conversation: string) => void): () => void {
    this.openers.add(fn);
    return () => { this.openers.delete(fn); };
  }

  private opened(serverId: string, conversation: string): void {
    for (const fn of this.openers) fn(serverId, conversation);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ---- saved state ----

  private load(): Record<string, Saved> {
    try {
      const raw = this.storage?.getItem(PUSH_STORAGE_KEY);
      const p = raw ? JSON.parse(raw) as Record<string, Saved> : {};
      return p && typeof p === 'object' ? p : {};
    } catch { return {}; }
  }

  private save(all: Record<string, Saved>): void {
    try {
      if (Object.keys(all).length) this.storage?.setItem(PUSH_STORAGE_KEY, JSON.stringify(all));
      else this.storage?.removeItem(PUSH_STORAGE_KEY);
    } catch { /* best-effort */ }
  }

  private saved(serverId: string): Saved {
    return this.load()[serverId] ?? {};
  }

  private patchSaved(serverId: string, patch: Partial<Saved> | null): void {
    const all = this.load();
    if (patch === null) delete all[serverId];
    else {
      const next: Saved = { ...all[serverId], ...patch };
      if (!next.off) delete next.off;
      if (!next.endpoint) delete next.endpoint;
      if (Object.keys(next).length) all[serverId] = next;
      else delete all[serverId];
    }
    this.save(all);
  }

  // ---- connections ----

  // A connection to follow (replacing an earlier one for the server).
  // Returns the detach.
  attach(server: PushServer): () => void {
    this.detach(server.serverId);
    const saved = this.saved(server.serverId);
    const l: Live = {
      server,
      facts: {
        platform: this.bridge?.platform ?? null,
        unsupported: this.unsupported,
        boson: server.boson,
        viaBouncer: server.viaBouncer,
        signedIn: server.signedIn,
        cap: null,
        vapid: null,
        permission: this.permission,
        off: !!saved.off,
        registration: 'idle',
      },
      connected: server.session.state() === 'connected',
      pendingEndpoint: null,
      pendingTimer: null,
      vapidTimer: null,
      epoch: 0,
      stops: [],
    };
    this.live.set(server.serverId, l);
    // Subscribed before, but no longer signed in with the account (signed
    // out of the network, or back as a guest): the server won't take an
    // UNREGISTER from a guest, so drop the endpoint; the server's next push
    // to it fails and it forgets the subscription itself.
    if (saved.endpoint && (!server.signedIn || server.viaBouncer || !server.boson)) {
      void this.bridge?.unsubscribe(server.serverId).catch(() => {});
      this.patchSaved(server.serverId, { endpoint: undefined });
    }
    l.stops.push(server.session.onEvent((e) => this.onEvent(l, e)));
    l.stops.push(server.session.onState((s) => this.onState(l, s)));
    if (l.connected) this.bridge?.setLive?.(server.serverId, true);
    this.emit();
    return () => { if (this.live.get(server.serverId) === l) this.detach(server.serverId); };
  }

  private detach(serverId: string): void {
    const l = this.live.get(serverId);
    if (!l) return;
    this.clearTimers(l);
    l.epoch++;
    for (const s of l.stops) s();
    this.live.delete(serverId);
    this.bridge?.setLive?.(serverId, false);
    this.emit();
  }

  private clearTimers(l: Live): void {
    if (l.pendingTimer) clearTimeout(l.pendingTimer);
    if (l.vapidTimer) clearTimeout(l.vapidTimer);
    l.pendingTimer = l.vapidTimer = null;
  }

  private setFacts(l: Live, patch: Partial<PushFacts>): void {
    l.facts = { ...l.facts, ...patch };
    this.emit();
  }

  private onState(l: Live, s: EngineState): void {
    const was = l.connected;
    l.connected = s === 'connected';
    if (was === l.connected) return;
    this.bridge?.setLive?.(l.server.serverId, l.connected);
    if (!l.connected) {
      // Learnt again on the next connect, which registers again.
      this.clearTimers(l);
      l.epoch++;
      l.pendingEndpoint = null;
      this.setFacts(l, { cap: null, vapid: null, registration: 'idle', error: undefined });
    }
  }

  private onEvent(l: Live, e: IrcEvent): void {
    switch (e.Kind) {
      case 'CAP': {
        const sub = (e.Args?.[0] ?? '').toUpperCase();
        if (sub !== 'ACK' && sub !== 'LS' && sub !== 'NEW') break;
        const raw = e.Message || (e.Args ?? []).slice(1).join(' ');
        const caps = raw.split(/\s+/).map((c) => c.split('=')[0]);
        if (caps.includes('draft/webpush') && sub === 'ACK') this.setFacts(l, { cap: true });
        break;
      }
      case '001': {
        if (l.facts.cap === null) this.setFacts(l, { cap: false });
        // VAPID= is in the 005 burst that follows; the end of the MOTD (or a
        // short wait) says it isn't coming.
        if (l.vapidTimer) clearTimeout(l.vapidTimer);
        l.vapidTimer = setTimeout(() => { l.vapidTimer = null; this.vapidSettled(l); }, this.vapidWaitMs);
        break;
      }
      case '005': {
        for (const tok of e.Args ?? []) {
          if (tok.startsWith('VAPID=')) this.setFacts(l, { vapid: tok.slice('VAPID='.length) });
          else if (tok === '-VAPID') this.setFacts(l, { vapid: '' });
        }
        break;
      }
      case 'WEBPUSH': {
        const [sub, endpoint] = e.Args ?? [];
        if ((sub ?? '').toUpperCase() === 'REGISTER' && endpoint && endpoint === l.pendingEndpoint) {
          if (l.pendingTimer) clearTimeout(l.pendingTimer);
          l.pendingTimer = null;
          l.pendingEndpoint = null;
          this.setFacts(l, { registration: 'ok', error: undefined });
        }
        break;
      }
      case 'FAIL': {
        const args = e.Args ?? [];
        if ((args[0] ?? '').toUpperCase() !== 'WEBPUSH' || (args[2] ?? '').toUpperCase() !== 'REGISTER') break;
        if (!l.pendingEndpoint) break;
        if (l.pendingTimer) clearTimeout(l.pendingTimer);
        l.pendingTimer = null;
        l.pendingEndpoint = null;
        this.setFacts(l, { registration: 'failed', error: e.Message || undefined });
        break;
      }
      default:
        if (isEndOfBurst(e.Kind)) {
          if (l.vapidTimer) { clearTimeout(l.vapidTimer); l.vapidTimer = null; }
          this.vapidSettled(l);
        }
    }
  }

  private vapidSettled(l: Live): void {
    if (l.facts.vapid === null) this.setFacts(l, { vapid: '' });
    this.evaluate(l.server.serverId);
  }

  private relayFor(host: string): Promise<string> {
    const b = this.bridge;
    if (!b?.relayFor) return Promise.resolve('');
    const key = host.toLowerCase();
    let p = this.relays.get(key);
    if (!p) {
      p = b.relayFor(host).catch(() => '');
      this.relays.set(key, p);
      // A failed lookup is retried on the next connect.
      void p.then((r) => { if (!r) this.relays.delete(key); });
    }
    return p;
  }

  // Registers when everything is known and allowed.
  private evaluate(serverId: string): void {
    const l = this.live.get(serverId);
    if (!l || !this.bridge || !l.connected) return;
    if (l.facts.registration !== 'idle') return;
    if (this.bridge.needsRelay && l.facts.relay === undefined && l.facts.cap === true && l.facts.vapid) {
      const epoch = l.epoch;
      void this.relayFor(l.server.host).then((relay) => {
        if (l.epoch !== epoch || this.live.get(serverId) !== l) return;
        this.setFacts(l, { relay });
        this.evaluate(serverId);
      });
      return;
    }
    if (!shouldRegister(l.facts)) return;
    void this.register(l);
  }

  private async register(l: Live): Promise<void> {
    const b = this.bridge!;
    const epoch = l.epoch;
    const { serverId, serverName, host } = l.server;
    this.setFacts(l, { registration: 'pending', error: undefined });
    let sub;
    try {
      sub = await b.subscribe({ serverId, serverName, host, vapid: l.facts.vapid! });
    } catch (err) {
      if (l.epoch !== epoch) return;
      const code = err instanceof PushError ? err.code : 'failed';
      if (code === 'denied') { this.permission = 'denied'; this.setFacts(l, { permission: 'denied', registration: 'idle' }); return; }
      if (code === 'no-relay') { this.setFacts(l, { relay: '', registration: 'idle' }); return; }
      this.setFacts(l, { registration: 'failed', error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (l.epoch !== epoch || !l.connected || l.facts.off) return;
    const prev = this.saved(serverId).endpoint;
    if (prev && prev !== sub.endpoint) l.server.session.raw(`WEBPUSH UNREGISTER ${prev}`);
    this.patchSaved(serverId, { endpoint: sub.endpoint });
    l.pendingEndpoint = sub.endpoint;
    l.pendingTimer = setTimeout(() => {
      l.pendingTimer = null;
      if (l.pendingEndpoint !== sub.endpoint) return;
      l.pendingEndpoint = null;
      this.setFacts(l, { registration: 'failed', error: 'No answer from the server.' });
    }, this.registerTimeoutMs);
    l.server.session.raw(`WEBPUSH REGISTER ${sub.endpoint} p256dh=${sub.p256dh};auth=${sub.auth}`);
  }

  // UNREGISTER where connected, then drop the endpoint (browser
  // subscription / relay mailbox) either way.
  private async takeDown(serverId: string): Promise<void> {
    const endpoint = this.saved(serverId).endpoint;
    const l = this.live.get(serverId);
    if (l) {
      if (l.pendingTimer) clearTimeout(l.pendingTimer);
      l.pendingTimer = null;
      l.epoch++;
      const sent = endpoint ?? l.pendingEndpoint;
      if (sent && l.connected) {
        try { l.server.session.raw(`WEBPUSH UNREGISTER ${sent}`); } catch { /* gone */ }
      }
      l.pendingEndpoint = null;
      this.setFacts(l, { registration: 'idle', error: undefined });
    }
    this.patchSaved(serverId, { endpoint: undefined });
    await this.bridge?.unsubscribe(serverId).catch(() => {});
  }

  // ---- the person's choices ----

  // The settings toggle. Turning on asks for permission first if needed
  // (call from the click: the web wants a user gesture).
  async setEnabled(serverId: string, on: boolean): Promise<void> {
    if (!on) {
      this.patchSaved(serverId, { off: true });
      const l = this.live.get(serverId);
      if (l) this.setFacts(l, { off: true });
      await this.takeDown(serverId);
      return;
    }
    if (this.bridge && this.permission !== 'granted') {
      try { this.permission = await this.bridge.requestPermission(); } catch { /* stays */ }
      for (const x of this.live.values()) this.setFacts(x, { permission: this.permission });
    }
    this.patchSaved(serverId, { off: undefined });
    const l = this.live.get(serverId);
    if (l) {
      // A failed attempt is tried again.
      this.setFacts(l, { off: false, ...(l.facts.registration === 'failed' ? { registration: 'idle' as const } : {}) });
    }
    this.evaluate(serverId);
  }

  // The server was removed (left, deleted): unsubscribe and forget it.
  async forget(serverId: string): Promise<void> {
    await this.takeDown(serverId);
    this.patchSaved(serverId, null);
    this.detach(serverId);
  }

  // Sign-out ('stop' phase, while the connections are still up).
  async clearForSignOut(): Promise<void> {
    const ids = new Set([...Object.keys(this.load()), ...this.live.keys()]);
    await Promise.all(Array.from(ids, (id) => this.takeDown(id)));
    try { this.storage?.removeItem(PUSH_STORAGE_KEY); } catch { /* best-effort */ }
    for (const id of Array.from(this.live.keys())) this.detach(id);
  }

  // ---- what Settings shows ----

  status(serverId: string): PushStatus {
    const l = this.live.get(serverId);
    return l ? pushStatus(l.facts) : { state: 'hidden' };
  }

  rows(): PushRow[] {
    const out: PushRow[] = [];
    for (const l of this.live.values()) {
      const status = pushStatus(l.facts);
      if (status.state !== 'hidden') out.push({ serverId: l.server.serverId, serverName: l.server.serverName, status, ...(l.facts.relay ? { relay: l.facts.relay } : {}) });
    }
    return out.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  // Test seam.
  factsFor(serverId: string): PushFacts | null { return this.live.get(serverId)?.facts ?? null; }
}

let singleton: PushManager | null = null;
let unregisterSignOut: (() => void) | null = null;

export function getPushManager(): PushManager {
  if (!singleton) {
    singleton = new PushManager();
    const m = singleton;
    unregisterSignOut = registerForSignOut({ name: 'push', phase: 'stop', clearForSignOut: () => m.clearForSignOut() });
    void m.start();
  }
  return singleton;
}

// Test seam.
export function setPushManagerForTest(m: PushManager | null): void {
  unregisterSignOut?.();
  unregisterSignOut = null;
  singleton?.dispose();
  singleton = m;
}
