import { channelKey, MAX_CHANNEL_ORDER } from './channel-order';

// SessionStore persists the user's chat session (the set of connected
// servers, their joined channels, and which server/channel is active) to
// localStorage so it can be restored on the next sign-in. Identity remains
// in-memory only and still requires the user to enter their password —
// this only restores the IRC-layer connection state, not the cryptographic
// keys.
//
// Storage format is versioned via the localStorage key suffix:
//   `boson:session:v1` — legacy single-server `{ server, channels, activeChannel }`.
//   `boson:session:v2` — multi-server `{ servers: SavedServerSession[], activeServerId }`.
// load() reads v2 first; if absent, reads v1 and migrates it forward.

// Per-server bouncer settings. `autoConnect` (default true when absent):
// when the bouncer isn't connected to the network at attach time, ask it to
// connect automatically.
export interface SavedServerBouncer {
  route: boolean;
  network: string;
  autoConnect?: boolean;
  // The user took the network down with "Disconnect network". Auto-connect
  // stays off on later attaches (relaunch, reconnect) until they connect it
  // again, so the bouncer isn't put back on the network behind their back.
  upstreamOff?: boolean;
}

export interface SavedServer {
  id: string;
  name: string;
  hostname: string;
  port: number;
  tls: boolean;
  // Per-server bouncer routing. When `route` is on AND the global bouncer
  // profile is enabled, the connect path targets the bouncer instead of this
  // server's host/port and authenticates as `username[/network]:password`.
  // Non-secret (the network name is just a ZNC label) — synced via the
  // session payload. Absent on servers never configured for a bouncer.
  bouncer?: SavedServerBouncer;
  // Left (Leave server / Disconnect) but kept for its bouncer settings: not
  // restored on launch, still listed under Directory → Bouncer, and routed
  // the same way when connected again (which clears this).
  parked?: boolean;
}

export interface SavedServerSession {
  server: SavedServer;
  channels: string[];
  activeChannel: string | null;
  // The user's own sidebar order (drag to reorder), as channel keys
  // (lowercased names; see channel-order.ts). Absent: the default order.
  channelOrder?: string[];
  // Set when the server was just routed through a bouncer network (or
  // another one): on its first attach the saved channels it doesn't have
  // yet are joined, to carry them over. Otherwise the bouncer's own list is
  // the truth: a saved channel it doesn't replay was left elsewhere
  // (another client, the bouncer's web app) and is dropped here rather
  // than joined again.
  bouncerUnseeded?: true;
}

export interface SavedSession {
  servers: SavedServerSession[];
  activeServerId: string | null;
}

const STORAGE_KEY_V1 = 'boson:session:v1';
const STORAGE_KEY_V2 = 'boson:session:v2';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type SessionStoreListener = (current: SavedSession | null) => void;

export class SessionStore {
  private readonly listeners = new Set<SessionStoreListener>();

  constructor(private readonly storage: Storage = defaultStorage()) {}

  // Subscribe to mutations. Fires AFTER every successful save/clear with the
  // latest snapshot. DirectoryBloc uses this to push changes to the backend.
  onChange(fn: SessionStoreListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emitChange(): void {
    const snap = this.load();
    this.listeners.forEach((fn) => { try { fn(snap); } catch { /* isolate */ } });
  }

  load(): SavedSession | null {
    // Prefer the v2 layout. Fall back to v1 and migrate forward so users
    // upgrading from earlier builds don't lose their saved server.
    const v2 = this.readKey(STORAGE_KEY_V2, isSavedSession);
    if (v2) return v2;
    const v1 = this.readKey(STORAGE_KEY_V1, isLegacySession);
    if (!v1) return null;
    const migrated: SavedSession = {
      servers: [{ server: v1.server, channels: v1.channels, activeChannel: v1.activeChannel }],
      activeServerId: v1.server.id,
    };
    // Persist forward + drop the legacy key so subsequent loads stay on v2.
    this.save(migrated);
    try { this.storage.removeItem(STORAGE_KEY_V1); } catch { /* best-effort */ }
    return migrated;
  }

  save(session: SavedSession): void {
    try {
      this.storage.setItem(STORAGE_KEY_V2, JSON.stringify(session));
    } catch {
      // Quota / disabled storage / etc. — best-effort.
    }
    this.emitChange();
  }

  clear(): void {
    try {
      this.storage.removeItem(STORAGE_KEY_V2);
      this.storage.removeItem(STORAGE_KEY_V1);
    } catch {
      // best-effort
    }
    this.emitChange();
  }

  // Replace the current stored payload without firing onChange. Used by the
  // backend-sync flow when applying a server-provided snapshot — re-emitting
  // would loop back and PUT the same payload right back to the server.
  saveSilent(session: SavedSession): void {
    try {
      this.storage.setItem(STORAGE_KEY_V2, JSON.stringify(session));
    } catch { /* best-effort */ }
  }

  // ---------- Mutators (load + write back) ----------

  // Upsert a server's session record. If the server is new, append it and
  // promote it to active. If it already exists, refresh its `server` fields
  // (host/port/name can change between directory updates) but keep channels.
  upsertServer(server: SavedServer): void {
    const current = this.load() ?? { servers: [], activeServerId: null };
    const idx = current.servers.findIndex((s) => s.server.id === server.id);
    if (idx === -1) {
      current.servers.push({ server, channels: [], activeChannel: null });
    } else {
      // Preserve the existing per-server bouncer routing across a refresh that
      // carries host/name updates but no `bouncer` field (e.g. a directory
      // reconnect) — otherwise toggling routing would be wiped on reconnect.
      const prev = current.servers[idx]!.server;
      current.servers[idx]!.server = { ...server, bouncer: server.bouncer ?? prev.bouncer };
    }
    if (!current.activeServerId) current.activeServerId = server.id;
    this.save(current);
  }

  // Set (or update) the per-server bouncer routing. Upserts a bare saved-server
  // row if one doesn't exist yet, so the setting can be configured before the
  // first connect. Fires onChange → backend session sync.
  setServerBouncer(serverId: string, bouncer: SavedServerBouncer): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target) return;
    // Routed through another bouncer network: carry the channels over on
    // its first attach.
    const was = target.server.bouncer;
    if (bouncer.route && (!was?.route || was.network !== bouncer.network)) target.bouncerUnseeded = true;
    else if (!bouncer.route) delete target.bouncerUnseeded;
    target.server = { ...target.server, bouncer };
    this.save(current);
  }

  // Drop a server from the saved set. Clears `activeServerId` if it pointed
  // at the removed server. When the last server is removed, clear the whole
  // record so `load()` returns null — an empty SavedSession is meaningless
  // and would otherwise leak past sign-out / disconnect-all flows.
  removeServer(serverId: string): void {
    const current = this.load();
    if (!current) return;
    const next = current.servers.filter((s) => s.server.id !== serverId);
    if (next.length === current.servers.length) return;
    if (next.length === 0) {
      this.clear();
      return;
    }
    current.servers = next;
    if (current.activeServerId === serverId) {
      current.activeServerId = next.find((s) => !s.server.parked)?.server.id ?? null;
    }
    this.save(current);
  }

  // Mark a server as left but keep its row (see SavedServer.parked).
  parkServer(serverId: string): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target) return;
    target.server = { ...target.server, parked: true };
    if (current.activeServerId === serverId) {
      current.activeServerId = current.servers.find((s) => !s.server.parked)?.server.id ?? null;
    }
    this.save(current);
  }

  // Set the joined-channels list for a given server.
  setChannels(serverId: string, channels: string[]): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target) return;
    target.channels = [...channels];
    this.save(current);
  }

  // Append a channel to a server's saved set. Idempotent — if already
  // present, no-op. Used by the bloc to record user-driven JOIN events
  // without ever overwriting the whole list (which would risk dropping
  // siblings during transient empty-state emits, e.g. a fresh ChatService
  // during reconnect).
  addChannel(serverId: string, channel: string): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target) return;
    if (target.channels.some((c) => channelKey(c) === channelKey(channel))) return;
    target.channels = [...target.channels, channel];
    this.save(current);
  }

  // Remove a channel from a server's saved set. Idempotent — if not
  // present, no-op. Called on user PART or self-KICK only; connection
  // drops never trigger this.
  removeChannel(serverId: string, channel: string): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target) return;
    // IRC channel names are case-insensitive: a part reports the channel's
    // key (lowercased), the saved name may be "#Boson".
    const key = channelKey(channel);
    if (!target.channels.some((c) => channelKey(c) === key)) return;
    target.channels = target.channels.filter((c) => channelKey(c) !== key);
    // A channel the user left drops out of their order too.
    if (target.channelOrder) {
      target.channelOrder = target.channelOrder.filter((k) => k !== key);
    }
    this.save(current);
  }

  // The user's sidebar order for a server (channel keys, top to bottom);
  // null resets it to the default order.
  setChannelOrder(serverId: string, order: readonly string[] | null): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target) return;
    const next = order && order.length > 0 ? order.slice(0, MAX_CHANNEL_ORDER) : undefined;
    const prev = target.channelOrder;
    if (prev === next || (prev && next && prev.length === next.length && prev.every((k, i) => k === next[i]))) return;
    if (next) target.channelOrder = next;
    else delete target.channelOrder;
    this.save(current);
  }

  // Set the active channel for a given server.
  // The first attach through a newly routed bouncer network carried the
  // channels over (see SavedServerSession.bouncerUnseeded).
  setBouncerSeeded(serverId: string): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target?.bouncerUnseeded) return;
    delete target.bouncerUnseeded;
    this.save(current);
  }

  setActiveChannel(serverId: string, channel: string | null): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target) return;
    if (target.activeChannel === channel) return;
    target.activeChannel = channel;
    this.save(current);
  }

  // Put servers in the rail order the user dragged them into. `ids` is the
  // new order of the servers it names; they're laid back into the slots
  // those servers held, so rows it doesn't name (parked ones) stay put.
  reorderServers(ids: readonly string[]): void {
    const current = this.load();
    if (!current) return;
    const rank = new Map(ids.map((id, i) => [id, i]));
    const slots = current.servers.flatMap((s, i) => (rank.has(s.server.id) ? [i] : []));
    const moved = slots.map((i) => current.servers[i]!)
      .sort((a, b) => rank.get(a.server.id)! - rank.get(b.server.id)!);
    if (moved.every((s, k) => s === current.servers[slots[k]!])) return;
    slots.forEach((slot, k) => { current.servers[slot] = moved[k]!; });
    this.save(current);
  }

  // Set which server is active in the rail.
  setActiveServer(serverId: string | null): void {
    const current = this.load();
    if (!current) return;
    if (current.activeServerId === serverId) return;
    current.activeServerId = serverId;
    this.save(current);
  }

  // ---------- internals ----------

  private readKey<T>(key: string, validate: (v: unknown) => v is T): T | null {
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return validate(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isSavedServer(v: unknown): v is SavedServer {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (!(typeof s.id === 'string' && s.id.length > 0
    && typeof s.hostname === 'string' && s.hostname.length > 0
    && typeof s.port === 'number'
    && typeof s.tls === 'boolean'
    && typeof s.name === 'string')) return false;
  // `bouncer` is optional + backward compatible: accept when absent, else
  // require the {route, network} shape so a malformed payload is rejected.
  if (s.bouncer !== undefined) {
    const b = s.bouncer as Record<string, unknown> | null;
    if (!b || typeof b !== 'object'
      || typeof b.route !== 'boolean' || typeof b.network !== 'string') return false;
    if (b.autoConnect !== undefined && typeof b.autoConnect !== 'boolean') return false;
    if (b.upstreamOff !== undefined && typeof b.upstreamOff !== 'boolean') return false;
  }
  if (s.parked !== undefined && typeof s.parked !== 'boolean') return false;
  return true;
}

function isSavedServerSession(v: unknown): v is SavedServerSession {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (!isSavedServer(obj.server)) return false;
  if (!Array.isArray(obj.channels)) return false;
  if (!obj.channels.every((c) => typeof c === 'string')) return false;
  if (obj.activeChannel !== null && typeof obj.activeChannel !== 'string') return false;
  if (obj.channelOrder !== undefined
    && !(Array.isArray(obj.channelOrder) && obj.channelOrder.every((c) => typeof c === 'string'))) return false;
  return true;
}

function isSavedSession(v: unknown): v is SavedSession {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.servers)) return false;
  if (!obj.servers.every(isSavedServerSession)) return false;
  if (obj.activeServerId !== null && typeof obj.activeServerId !== 'string') return false;
  return true;
}

interface LegacySession {
  server: SavedServer;
  channels: string[];
  activeChannel: string | null;
}

function isLegacySession(v: unknown): v is LegacySession {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (!isSavedServer(obj.server)) return false;
  if (!Array.isArray(obj.channels)) return false;
  if (!obj.channels.every((c) => typeof c === 'string')) return false;
  if (obj.activeChannel !== null && typeof obj.activeChannel !== 'string') return false;
  return true;
}

// The synced session from the account, with this device's own place in it
// kept: which server is open, and which channel on each. Those say where
// this device was, not what the account has, and a relaunch should come back
// to them — not to wherever another device was last (each device's pushes
// carry its own), nor to a stale cloud copy when this device's last switch
// never reached it (a phone killed in the background before the push left).
// The servers and their channels still come from `remote`; a cursor this
// device has for a server or channel that's gone from it falls back to the
// remote one.
export function withLocalCursor(remote: SavedSession, local: SavedSession | null): SavedSession {
  if (!local || !remote || !Array.isArray(remote.servers)) return remote;
  const localById = new Map(local.servers.map((s) => [s.server.id, s]));
  const servers = remote.servers.map((r) => {
    const mine = r && typeof r === 'object' && r.server ? localById.get(r.server.id) : undefined;
    if (!mine?.activeChannel || !Array.isArray(r.channels)) return r;
    const key = channelKey(mine.activeChannel);
    // A channel must still be in the synced set; a DM is always fine.
    const isChannel = /^[#&]/.test(mine.activeChannel);
    if (isChannel && !r.channels.some((c) => typeof c === 'string' && channelKey(c) === key)) return r;
    return { ...r, activeChannel: mine.activeChannel };
  });
  const usable = (id: string | null): boolean => !!id
    && servers.some((s) => s?.server?.id === id && !s.server.parked);
  const activeServerId = usable(local.activeServerId) ? local.activeServerId : remote.activeServerId;
  return { ...remote, servers, activeServerId };
}

function defaultStorage(): Storage {
  // happy-dom in tests provides window.localStorage; main runtime is the desktop webview.
  if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
    return (globalThis as unknown as { localStorage: Storage }).localStorage;
  }
  return memoryStorage();
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}
