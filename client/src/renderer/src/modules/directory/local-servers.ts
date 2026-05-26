import type { Server } from './directory.types';

// User-added "advanced mode" servers — IRC daemons the user wants to connect
// to that aren't in the public Boson directory. Stored in localStorage so
// they survive reloads. Merged with the backend directory on every list,
// with backend entries winning on hostname collision (the public
// registration is authoritative if both exist).
//
// These are NEVER published to the backend's /servers endpoint — they're
// purely local convenience entries for "connect to my friend's IRCd at
// 192.168.x.y" without forcing every IRC daemon onto Boson's directory.

const STORAGE_KEY = 'boson:local-servers:v1';

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined') return null;
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

export interface LocalServer {
  // Mint-once UUID-like id (random, prefixed `local-`). Used by SessionStore
  // and engine routing the same as any other server id.
  id: string;
  name: string;
  hostname: string;
  port: number;
  tls: boolean;
}

export function loadLocalServers(): LocalServer[] {
  const s = getStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLocalServer);
  } catch {
    return [];
  }
}

export function saveLocalServers(items: ReadonlyArray<LocalServer>): void {
  const s = getStorage();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* best-effort */ }
}

export function addLocalServer(input: Omit<LocalServer, 'id'>): LocalServer {
  const all = loadLocalServers();
  // Idempotent on hostname+port — re-adding the same host just updates the
  // name. (Local list is short and user-curated; no need for fancy merge.)
  const idx = all.findIndex((s) => s.hostname === input.hostname && s.port === input.port);
  let next: LocalServer;
  if (idx >= 0) {
    next = { ...all[idx]!, ...input };
    all[idx] = next;
  } else {
    next = { id: mintId(), ...input };
    all.push(next);
  }
  saveLocalServers(all);
  return next;
}

export function removeLocalServer(id: string): void {
  const all = loadLocalServers();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return;
  saveLocalServers(next);
}

// Promote a LocalServer into a directory `Server` so the existing list code
// can render both kinds uniformly. Synthesised fields use neutral defaults.
export function asDirectoryServer(s: LocalServer): Server {
  return {
    id: s.id,
    hostname: s.hostname,
    port: s.port,
    tls: s.tls,
    name: s.name,
    tags: ['local'],
    languages: [],
    is_nsfw: false,
    is_featured: false,
    verification_status: 'pending',
    health_status: 'unknown',
    registered_at: new Date(0).toISOString(),
  };
}

// Merge: backend list first, then local-only entries whose hostname isn't
// already present in the backend list. Per spec, backend wins on collision.
export function mergeWithLocal(
  backend: ReadonlyArray<Server>,
  local: ReadonlyArray<LocalServer>,
): Server[] {
  const seen = new Set(backend.map((s) => s.hostname.toLowerCase()));
  const merged: Server[] = backend.slice();
  for (const l of local) {
    if (seen.has(l.hostname.toLowerCase())) continue;
    merged.push(asDirectoryServer(l));
  }
  return merged;
}

function isLocalServer(v: unknown): v is LocalServer {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && o.id.length > 0
    && typeof o.name === 'string'
    && typeof o.hostname === 'string' && o.hostname.length > 0
    && typeof o.port === 'number'
    && typeof o.tls === 'boolean';
}

function mintId(): string {
  // 8 random base36 chars is enough for a local-only id; no collision
  // concern since the directory is single-user and small.
  const suffix = Math.random().toString(36).slice(2, 10);
  return `local-${suffix}`;
}
