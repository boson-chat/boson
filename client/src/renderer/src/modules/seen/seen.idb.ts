// seen.idb.ts — IndexedDB SeenBackend + the per-namespace store registry.
//
// DB "boson-seen" v1, object store "seen", keyPath "_pk" =
// `${ns}\u0001${foldedNick}`, where ns is `${userId || 'guest'}::${serverId}`.
// A namespace's records are one key range, so load / clear are range scans;
// sign-out wipes the `${userId}::` prefix. Unlike the older-store this one
// is kept across runs: remembering people after they've left is the point.
import { SeenStore, foldNick, type SeenBackend, type SeenRecord } from './seen.store';

const DB_NAME = 'boson-seen';
const STORE = 'seen';

interface Row extends SeenRecord { _pk: string }

export class IDBSeenBackend implements SeenBackend {
  private db: Promise<IDBDatabase> | null = null;
  constructor(private readonly idb: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: '_pk' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
    }
    return this.db;
  }

  async load(ns: string): Promise<SeenRecord[]> {
    const db = await this.open();
    const p = `${ns}\u0001`;
    return new Promise<SeenRecord[]>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll(IDBKeyRange.bound(p, `${p}￿`));
      req.onsuccess = () => resolve((req.result as Row[]).map(({ _pk: _drop, ...r }) => r));
      req.onerror = () => reject(req.error);
    });
  }

  async save(ns: string, put: readonly SeenRecord[], del: readonly string[]): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const k of del) store.delete(`${ns}\u0001${k}`);
      for (const r of put) store.put({ ...r, _pk: `${ns}\u0001${foldNick(r.nick)}` } satisfies Row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }

  async clear(prefix: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (prefix) store.delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
      else store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }
}

let backend: SeenBackend | null | undefined;
function sharedBackend(): SeenBackend | null {
  if (backend === undefined) backend = typeof indexedDB !== 'undefined' ? new IDBSeenBackend() : null;
  return backend;
}

const stores = new Map<string, SeenStore>();

/** The namespace for a server's records: per signed-in user, else 'guest'. */
export function seenNamespace(serverId: string, userId?: string | null): string {
  return `${userId || 'guest'}::${serverId}`;
}

/** The (one, shared) store for a namespace. */
export function seenStoreFor(ns: string): SeenStore {
  let s = stores.get(ns);
  if (!s) {
    s = new SeenStore(ns, sharedBackend());
    stores.set(ns, s);
    ensureUnloadFlush();
  }
  return s;
}

/** "Clear remembered hosts": every server, every user on this device. */
export async function clearAllSeen(): Promise<void> {
  await Promise.all([...stores.values()].map((s) => s.clear()));
  try { await sharedBackend()?.clear(''); } catch { /* best-effort */ }
}

/** Sign-out: forget what this user's sessions remembered. */
export async function wipeSeenForUser(userId: string): Promise<void> {
  const prefix = `${userId}::`;
  await Promise.all([...stores.entries()].filter(([ns]) => ns.startsWith(prefix)).map(([, s]) => s.clear()));
  try { await sharedBackend()?.clear(prefix); } catch { /* best-effort */ }
}

let unloadHooked = false;
function ensureUnloadFlush(): void {
  if (unloadHooked) return;
  unloadHooked = true;
  const w = globalThis as { addEventListener?: (t: string, l: () => void) => void };
  w.addEventListener?.('pagehide', () => { for (const s of stores.values()) void s.flush(); });
}

// Test seam.
export function __resetSeenRegistry(b?: SeenBackend | null): void {
  stores.clear();
  backend = b;
}
