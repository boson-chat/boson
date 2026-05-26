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

export interface SavedServer {
  id: string;
  name: string;
  hostname: string;
  port: number;
  tls: boolean;
}

export interface SavedServerSession {
  server: SavedServer;
  channels: string[];
  activeChannel: string | null;
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
      current.servers[idx]!.server = server;
    }
    if (!current.activeServerId) current.activeServerId = server.id;
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
      current.activeServerId = next[0]?.server.id ?? null;
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
    if (target.channels.includes(channel)) return;
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
    if (!target.channels.includes(channel)) return;
    target.channels = target.channels.filter((c) => c !== channel);
    this.save(current);
  }

  // Set the active channel for a given server.
  setActiveChannel(serverId: string, channel: string | null): void {
    const current = this.load();
    if (!current) return;
    const target = current.servers.find((s) => s.server.id === serverId);
    if (!target) return;
    if (target.activeChannel === channel) return;
    target.activeChannel = channel;
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
  return typeof s.id === 'string' && s.id.length > 0
    && typeof s.hostname === 'string' && s.hostname.length > 0
    && typeof s.port === 'number'
    && typeof s.tls === 'boolean'
    && typeof s.name === 'string';
}

function isSavedServerSession(v: unknown): v is SavedServerSession {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (!isSavedServer(obj.server)) return false;
  if (!Array.isArray(obj.channels)) return false;
  if (!obj.channels.every((c) => typeof c === 'string')) return false;
  if (obj.activeChannel !== null && typeof obj.activeChannel !== 'string') return false;
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

function defaultStorage(): Storage {
  // happy-dom in tests provides window.localStorage; main runtime is Electron renderer.
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
