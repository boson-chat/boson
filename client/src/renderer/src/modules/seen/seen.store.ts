// seen.store.ts — what we last knew about each nick on a server, kept after
// they leave: user@host (IP or cloak), account, realname, when and where we
// last saw them. Fed by ChatService from JOIN (extended-join), WHO, WHOIS,
// message prefixes (live and replayed), CHGHOST, SETNAME, ACCOUNT, PART,
// QUIT, KICK and NICK. Read by the nick profile / hover card, /whois on
// someone who's gone, and /seen.
//
// Local only: never sent anywhere. One store per (user, server) namespace,
// shared by that server's connections (like the older-store), persisted via
// a SeenBackend (IndexedDB in the app, see seen.idb.ts). Capped at the most
// recent SEEN_CAP nicks, evicting whoever was seen longest ago. Gated by the
// "Remember people's hosts after they leave" setting: while it's off,
// nothing is recorded and nothing remembered is shown.
import { signal } from '@preact/signals';
import { getPrivacySettings } from '../ui/privacy.store';

export const SEEN_CAP = 5000;
/** Previous user@host values kept per nick. */
export const SEEN_PREV_HOSTS = 5;
/** Channels kept per nick, most recent first. */
export const SEEN_CHANNELS = 8;
const FLUSH_MS = 1500;

export interface SeenRecord {
  nick: string;
  user?: string;
  host?: string;
  account?: string;
  realname?: string;
  /** The real host / IP behind a cloak, when a WHOIS showed it (338/378). */
  actualHost?: string;
  /** When we last saw them do anything (or saw a WHO/WHOIS of them). */
  lastSeenAt: number;
  /** When a WHOIS of them last answered. */
  lastWhoisAt?: number;
  /** Where we saw them, most recent first. */
  channels: string[];
  /** Earlier "user@host" values, newest first (≤ SEEN_PREV_HOSTS). */
  prevHosts?: string[];
}

/** One observation of a nick. Absent fields are "not said", not "cleared". */
export interface SeenSighting {
  user?: string;
  host?: string;
  /** null: logged out (ACCOUNT *). */
  account?: string | null;
  realname?: string;
  actualHost?: string;
  channel?: string;
  /** When (epoch ms); default now. Replayed history passes its own time. */
  at?: number;
  /** From a WHOIS reply. */
  whois?: boolean;
}

// Where records live between runs. Keys are `${ns}\u0001${foldedNick}`;
// clear(prefix) drops every key starting with prefix ('' = everything).
export interface SeenBackend {
  load(ns: string): Promise<SeenRecord[]>;
  save(ns: string, put: readonly SeenRecord[], del: readonly string[]): Promise<void>;
  clear(prefix: string): Promise<void>;
}

/** IRC case-folding (rfc1459): ASCII lower-case plus []\~ → {}|^. */
export function foldNick(nick: string): string {
  return nick.toLowerCase().replace(/[[\]\\~]/g, (c) => ({ '[': '{', ']': '}', '\\': '|', '~': '^' })[c]!);
}

/** "~user@host", or the host alone when the ident is unknown. */
export function seenMask(r: Pick<SeenRecord, 'user' | 'host'>): string | null {
  if (!r.host) return null;
  return r.user ? `${r.user}@${r.host}` : r.host;
}

function pushFront(list: readonly string[], v: string, cap: number): string[] {
  return [v, ...list.filter((x) => x !== v)].slice(0, cap);
}

// Two records of one nick → one: the newer one's fields win, the older one
// fills the gaps; channel and host histories are merged newest first.
export function mergeSeen(a: SeenRecord, b: SeenRecord): SeenRecord {
  const [newer, older] = a.lastSeenAt >= b.lastSeenAt ? [a, b] : [b, a];
  const out: SeenRecord = { ...older, ...stripUndefined(newer) };
  out.channels = [...newer.channels, ...older.channels.filter((c) => !newer.channels.includes(c))].slice(0, SEEN_CHANNELS);
  const prev = [...(newer.prevHosts ?? []), ...(older.prevHosts ?? [])];
  const olderMask = seenMask(older);
  if (olderMask && olderMask !== seenMask(out)) prev.unshift(olderMask);
  const cur = seenMask(out);
  const hosts = [...new Set(prev)].filter((h) => h !== cur).slice(0, SEEN_PREV_HOSTS);
  if (hosts.length > 0) out.prevHosts = hosts; else delete out.prevHosts;
  const whoisAt = Math.max(a.lastWhoisAt ?? 0, b.lastWhoisAt ?? 0);
  if (whoisAt > 0) out.lastWhoisAt = whoisAt; else delete out.lastWhoisAt;
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export interface SeenStoreOptions {
  cap?: number;
  /** Whether recording / showing is allowed; default the privacy setting. */
  enabled?: () => boolean;
  flushMs?: number;
}

export class SeenStore {
  /** Bumped when what a profile would show changes; get() subscribes to it. */
  readonly version = signal(0);
  /** Settles once the persisted records are in. */
  readonly ready: Promise<void>;
  private readonly recs = new Map<string, SeenRecord>();
  private readonly dirty = new Set<string>();
  private readonly deleted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private readonly cap: number;
  private readonly enabled: () => boolean;
  private readonly flushMs: number;
  // Bumped by clear(): a load still in flight from before it is dropped.
  private generation = 0;

  constructor(readonly ns: string, private readonly backend: SeenBackend | null = null, opts: SeenStoreOptions = {}) {
    this.cap = opts.cap ?? SEEN_CAP;
    this.enabled = opts.enabled ?? (() => getPrivacySettings().rememberHosts);
    this.flushMs = opts.flushMs ?? FLUSH_MS;
    const gen = this.generation;
    this.ready = backend
      ? backend.load(ns).then((rows) => { if (gen === this.generation) this.absorb(rows); }, () => {})
      : Promise.resolve();
  }

  get size(): number { return this.recs.size; }

  /** Whether sightings are being recorded (the privacy setting). */
  get recording(): boolean { return this.enabled(); }

  /** The remembered record for nick, or undefined (also while disabled). */
  get(nick: string): SeenRecord | undefined {
    void this.version.value;
    return this.peek(nick);
  }

  /** get() without subscribing. */
  peek(nick: string): SeenRecord | undefined {
    if (!nick || !this.enabled()) return undefined;
    return this.recs.get(foldNick(nick));
  }

  /** Every record, most recently seen first. */
  all(): SeenRecord[] {
    if (!this.enabled()) return [];
    return [...this.recs.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** Record a sighting of nick. */
  note(nick: string, s: SeenSighting): void {
    if (!nick || nick === '*' || !this.enabled()) return;
    const key = foldNick(nick);
    const at = s.at ?? Date.now();
    const cur = this.recs.get(key);
    let next: SeenRecord;
    let visible = false;
    if (!cur) {
      next = { nick, lastSeenAt: at, channels: s.channel ? [s.channel] : [] };
      if (s.user) next.user = s.user;
      if (s.host) next.host = s.host;
      if (s.account) next.account = s.account;
      if (s.realname) next.realname = s.realname;
      if (s.actualHost) next.actualHost = s.actualHost;
      if (s.whois) next.lastWhoisAt = at;
      visible = true;
    } else if (at >= cur.lastSeenAt) {
      next = { ...cur, nick, lastSeenAt: at };
      const userChanged = s.user !== undefined && s.user !== cur.user;
      const hostChanged = s.host !== undefined && s.host !== cur.host;
      if (userChanged || hostChanged) {
        const old = seenMask(cur);
        if (s.user !== undefined) next.user = s.user;
        if (s.host !== undefined) next.host = s.host;
        const now = seenMask(next);
        if (old && old !== now) {
          const prev = pushFront(cur.prevHosts ?? [], old, SEEN_PREV_HOSTS).filter((h) => h !== now);
          next.prevHosts = prev;
        }
      }
      if (s.account === null) delete next.account;
      else if (s.account) next.account = s.account;
      if (s.realname !== undefined && s.realname !== '') next.realname = s.realname;
      if (s.actualHost) next.actualHost = s.actualHost;
      else if (hostChanged) delete next.actualHost;
      if (s.channel && cur.channels[0] !== s.channel) next.channels = pushFront(cur.channels, s.channel, SEEN_CHANNELS);
      if (s.whois) next.lastWhoisAt = at;
      visible = next.user !== cur.user || next.host !== cur.host || next.account !== cur.account
        || next.realname !== cur.realname || next.actualHost !== cur.actualHost || next.channels !== cur.channels || nick !== cur.nick || !!s.whois;
    } else {
      // An older sighting (replayed history): fill gaps only.
      next = { ...cur };
      if (!next.host && s.host) { next.host = s.host; if (s.user) next.user = s.user; }
      if (!next.account && s.account) next.account = s.account;
      if (!next.realname && s.realname) next.realname = s.realname;
      if (s.channel && !next.channels.includes(s.channel)) next.channels = [...next.channels, s.channel].slice(0, SEEN_CHANNELS);
      visible = next.host !== cur.host || next.account !== cur.account || next.realname !== cur.realname || next.channels !== cur.channels;
      if (!visible) return;
    }
    this.recs.set(key, next);
    this.deleted.delete(key);
    this.dirty.add(key);
    if (!cur) this.evict();
    if (visible) this.version.value++;
    this.schedule();
  }

  /**
   * A NICK change: the new nick takes over the identity (and keeps the old
   * one's channels); the old nick's record stays, last seen now.
   */
  rename(from: string, to: string, at: number = Date.now()): void {
    if (!this.enabled() || !from || !to) return;
    const cur = this.recs.get(foldNick(from));
    this.note(from, { at });
    if (!cur) { this.note(to, { at }); return; }
    const existing = this.recs.get(foldNick(to));
    const carried: SeenRecord = { ...cur, nick: to, lastSeenAt: at };
    const merged = existing ? mergeSeen(carried, existing) : carried;
    const key = foldNick(to);
    this.recs.set(key, { ...merged, nick: to });
    this.deleted.delete(key);
    this.dirty.add(key);
    if (!existing) this.evict();
    this.version.value++;
    this.schedule();
  }

  /** Forget everything for this namespace (memory and disk). */
  clear(): Promise<void> {
    this.generation++;
    this.recs.clear();
    this.dirty.clear();
    this.deleted.clear();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.version.value++;
    if (!this.backend) return Promise.resolve();
    const backend = this.backend;
    this.saving = this.saving.then(() => backend.clear(`${this.ns}\u0001`)).catch(() => {});
    return this.saving;
  }

  /** Write what changed now (also run on a timer after each change). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.backend || (this.dirty.size === 0 && this.deleted.size === 0)) return this.saving;
    const put: SeenRecord[] = [];
    for (const k of this.dirty) { const r = this.recs.get(k); if (r) put.push(r); }
    const del = [...this.deleted];
    this.dirty.clear();
    this.deleted.clear();
    const backend = this.backend;
    this.saving = this.saving.then(() => backend.save(this.ns, put, del)).catch(() => {});
    return this.saving;
  }

  private schedule(): void {
    if (!this.backend || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushMs);
  }

  // Over the cap: drop whoever was seen longest ago, down to a little under
  // it, so a burst of new nicks (a big channel's NAMES / WHO) sorts once
  // rather than scanning the whole map per nick.
  private evict(): void {
    if (this.recs.size <= this.cap) return;
    const keep = this.cap - Math.floor(this.cap / 50);
    const byAge = [...this.recs].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (const [k] of byAge.slice(0, byAge.length - keep)) {
      this.recs.delete(k);
      this.dirty.delete(k);
      this.deleted.add(k);
    }
  }

  // Persisted records, merged with anything noted before they arrived.
  private absorb(rows: readonly SeenRecord[]): void {
    if (rows.length === 0) return;
    for (const row of rows) {
      if (!row?.nick || typeof row.lastSeenAt !== 'number') continue;
      const rec: SeenRecord = { ...row, channels: Array.isArray(row.channels) ? row.channels : [] };
      const key = foldNick(rec.nick);
      const cur = this.recs.get(key);
      if (cur) { this.recs.set(key, mergeSeen(cur, rec)); this.dirty.add(key); }
      else this.recs.set(key, rec);
    }
    this.evict();
    this.version.value++;
    if (this.dirty.size > 0 || this.deleted.size > 0) this.schedule();
  }
}

// An in-memory SeenBackend (tests; no IndexedDB). Stores copies, as the
// real one would.
export class MemorySeenBackend implements SeenBackend {
  readonly rows = new Map<string, SeenRecord>();
  async load(ns: string): Promise<SeenRecord[]> {
    const p = `${ns}\u0001`;
    return [...this.rows].filter(([k]) => k.startsWith(p)).map(([, r]) => structuredClone(r));
  }
  async save(ns: string, put: readonly SeenRecord[], del: readonly string[]): Promise<void> {
    for (const k of del) this.rows.delete(`${ns}\u0001${k}`);
    for (const r of put) this.rows.set(`${ns}\u0001${foldNick(r.nick)}`, structuredClone(r));
  }
  async clear(prefix: string): Promise<void> {
    for (const k of [...this.rows.keys()]) if (k.startsWith(prefix)) this.rows.delete(k);
  }
}
