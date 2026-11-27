// A small key-value store in IndexedDB that the page and the push service
// workers (push-sw.ts) share: the notification settings the workers filter
// by, and which servers this page has connected right now.
const DB = 'boson-push';
const STORE = 'kv';

function open(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(idb: IDBFactory, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | null): Promise<T | undefined> {
  const db = await open(idb);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export interface PushKV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export function pushKV(idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB): PushKV {
  if (!idb) {
    const m = new Map<string, unknown>();
    return {
      get: async <T>(k: string) => m.get(k) as T | undefined,
      set: async (k, v) => { m.set(k, v); },
      del: async (k) => { m.delete(k); },
    };
  }
  return {
    get: <T>(k: string) => tx<T>(idb, 'readonly', (s) => s.get(k)),
    set: async (k, v) => { await tx(idb, 'readwrite', (s) => s.put(v, k)); },
    del: async (k) => { await tx(idb, 'readwrite', (s) => s.delete(k)); },
  };
}

export const PREFS_KEY = 'prefs';
export const liveKey = (serverId: string): string => `live:${serverId}`;
// A page's heartbeat is this fresh while its connection is up (hidden tabs
// run timers about once a minute).
export const LIVE_EVERY_MS = 30_000;
export const LIVE_FOR_MS = 120_000;
