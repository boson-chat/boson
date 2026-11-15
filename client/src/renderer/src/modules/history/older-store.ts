// older-store.ts — where a conversation's lines go when they leave memory.
//
// ChatService keeps only a small window of each conversation in memory (the
// open one ~200 lines, the rest a short tail). Lines trimmed off the top
// go here, oldest first, and come back a page at a time on scroll-up (then
// the server's own history, when it has one). Two implementations:
//   • IDBOlderStore — IndexedDB ("boson-chat-spill"), so they're on disk,
//     not in the JS heap. Session-only: emptied on the first open of each
//     app run (it's scrollback for this run, not an archive: persistent
//     history is IDBChatHistoryStore's job).
//   • MemoryOlderStore — arrays (tests; no IndexedDB).
//
// Both answer the synchronous questions ChatService asks on every line
// (is anything held for this conversation? is this line among them?) from
// a small in-memory index: a count per conversation and a set of 53-bit
// hashes of each held line's identity (msgid, or time + sender + text).
import type { ChatMessage } from '../chat/chat.types';

export interface OlderStore {
  // Hold msgs (any order; already-held lines are skipped).
  put(key: string, msgs: readonly ChatMessage[]): void;
  // Anything held for key?
  has(key: string): boolean;
  count(key: string): number;
  // Whether a line like m is held for key.
  contains(key: string, m: ChatMessage): boolean;
  // Remove and return the newest n held lines, oldest first. Synchronous
  // for the memory store, a promise for IndexedDB.
  takeNewest(key: string, n: number): ChatMessage[] | Promise<ChatMessage[]>;
  // Forget key's lines (/clear, part).
  drop(key: string): void;
}

// The identity two copies of a line share (see ChatService.isDuplicateMessage).
export function lineIdentity(m: ChatMessage): string {
  return m.msgid ? `id:${m.msgid}` : `${m.serverTime ?? m.timestamp}\u0000${m.from}\u0000${m.text}`;
}

// cyrb53: a fast 53-bit string hash (collisions negligible at this scale).
export function hash53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// The per-conversation index both stores keep in memory.
class HeldIndex {
  private readonly counts = new Map<string, number>();
  private readonly hashes = new Map<string, Set<number>>();

  // Marks m held; false when it already was.
  add(key: string, m: ChatMessage): boolean {
    let set = this.hashes.get(key);
    if (!set) { set = new Set(); this.hashes.set(key, set); }
    const h = hash53(lineIdentity(m));
    if (set.has(h)) return false;
    set.add(h);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return true;
  }

  remove(key: string, m: ChatMessage): void {
    const set = this.hashes.get(key);
    if (set?.delete(hash53(lineIdentity(m)))) {
      const n = (this.counts.get(key) ?? 1) - 1;
      if (n > 0) this.counts.set(key, n);
      else { this.counts.delete(key); this.hashes.delete(key); }
    }
  }

  // Lines dropped without being read back (past the cap).
  forgetCount(key: string, n: number): void {
    const left = (this.counts.get(key) ?? 0) - n;
    if (left > 0) this.counts.set(key, left);
    else this.counts.delete(key);
  }

  count(key: string): number { return this.counts.get(key) ?? 0; }

  contains(key: string, m: ChatMessage): boolean {
    return this.hashes.get(key)?.has(hash53(lineIdentity(m))) ?? false;
  }

  drop(key: string): void {
    this.counts.delete(key);
    this.hashes.delete(key);
  }
}

// At most this many lines held per conversation (the oldest go).
export const OLDER_STORE_CAP = 10_000;

export class MemoryOlderStore implements OlderStore {
  private readonly lines = new Map<string, ChatMessage[]>();
  private readonly index = new HeldIndex();

  constructor(private readonly cap = OLDER_STORE_CAP) {}

  put(key: string, msgs: readonly ChatMessage[]): void {
    const add = msgs.filter((m) => this.index.add(key, m));
    if (add.length === 0) return;
    const next = [...(this.lines.get(key) ?? []), ...add].sort((a, b) => a.timestamp - b.timestamp);
    if (next.length > this.cap) {
      const cut = next.splice(0, next.length - this.cap);
      for (const m of cut) this.index.remove(key, m);
    }
    this.lines.set(key, next);
  }

  has(key: string): boolean { return this.index.count(key) > 0; }
  count(key: string): number { return this.index.count(key); }
  contains(key: string, m: ChatMessage): boolean { return this.index.contains(key, m); }

  takeNewest(key: string, n: number): ChatMessage[] {
    const all = this.lines.get(key) ?? [];
    const page = all.slice(Math.max(0, all.length - n));
    const rest = all.slice(0, all.length - page.length);
    if (rest.length > 0) this.lines.set(key, rest);
    else this.lines.delete(key);
    for (const m of page) this.index.remove(key, m);
    return page;
  }

  drop(key: string): void {
    this.lines.delete(key);
    this.index.drop(key);
  }
}

// ---- IndexedDB ----

const DB_NAME = 'boson-chat-spill';
const STORE = 'older';
const FLUSH_MS = 250;

interface Row extends ChatMessage {
  _pk: string;
}

// Lexical order of _pk = (conversation, time, sequence).
function pkPrefix(ns: string, key: string): string {
  return `${ns}\u0001${key}\u0001`;
}
function pad(ts: number): string {
  return Math.max(0, Math.floor(ts)).toString().padStart(16, '0');
}

let wiped: Promise<void> | null = null;

// Empties the database once per app run (its lines are this run's).
function wipeOnce(idb: IDBFactory): Promise<void> {
  if (!wiped) {
    wiped = new Promise<void>((resolve) => {
      const req = idb.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
  return wiped;
}

export class IDBOlderStore implements OlderStore {
  private readonly index = new HeldIndex();
  private db: Promise<IDBDatabase> | null = null;
  private seq = 0;
  private buffer: Array<{ key: string; m: ChatMessage }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  // ns: which server's conversations (one store per server).
  constructor(private readonly ns: string, private readonly cap = OLDER_STORE_CAP, private readonly idb: IDBFactory = indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = wipeOnce(this.idb).then(() => new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: '_pk' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    }
    return this.db;
  }

  put(key: string, msgs: readonly ChatMessage[]): void {
    let added = false;
    for (const m of msgs) {
      if (!this.index.add(key, m)) continue;
      this.buffer.push({ key, m });
      added = true;
    }
    if (added && !this.timer) this.timer = setTimeout(() => { void this.flush(); }, FLUSH_MS);
  }

  has(key: string): boolean { return this.index.count(key) > 0; }
  count(key: string): number { return this.index.count(key); }
  contains(key: string, m: ChatMessage): boolean { return this.index.contains(key, m); }

  // Writes what's buffered (one transaction), then trims conversations
  // over the cap.
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return this.flushing;
    this.flushing = this.flushing.then(async () => {
      const db = await this.open();
      const over = new Set<string>();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const { key, m } of batch) {
          const row: Row = { ...m, _pk: `${pkPrefix(this.ns, key)}${pad(m.timestamp)}\u0001${String(++this.seq).padStart(10, '0')}` };
          delete (row as Partial<ChatMessage>).pending;
          store.put(row);
          if (this.index.count(key) > this.cap) over.add(key);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
      for (const key of over) await this.trim(db, key, this.index.count(key) - this.cap);
    }).catch(() => {});
    return this.flushing;
  }

  private trim(db: IDBDatabase, key: string, n: number): Promise<void> {
    if (n <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      const p = pkPrefix(this.ns, key);
      const req = tx.objectStore(STORE).openCursor(IDBKeyRange.bound(p, `${p}￿`));
      let left = n;
      req.onsuccess = () => {
        const c = req.result;
        if (!c || left <= 0) return;
        this.index.remove(key, c.value as Row);
        c.delete();
        left--;
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }

  async takeNewest(key: string, n: number): Promise<ChatMessage[]> {
    await this.flush();
    const db = await this.open();
    const out = await new Promise<ChatMessage[]>((resolve) => {
      const got: ChatMessage[] = [];
      const tx = db.transaction(STORE, 'readwrite');
      const p = pkPrefix(this.ns, key);
      const req = tx.objectStore(STORE).openCursor(IDBKeyRange.bound(p, `${p}￿`), 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c || got.length >= n) return;
        const { _pk: _drop, ...m } = c.value as Row;
        got.push(m as ChatMessage);
        c.delete();
        c.continue();
      };
      tx.oncomplete = () => resolve(got);
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    });
    for (const m of out) this.index.remove(key, m);
    return out.reverse();
  }

  drop(key: string): void {
    this.index.drop(key);
    this.buffer = this.buffer.filter((b) => b.key !== key);
    void this.flushing.then(async () => {
      const db = await this.open();
      const p = pkPrefix(this.ns, key);
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(IDBKeyRange.bound(p, `${p}￿`));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    }).catch(() => {});
  }
}

// IndexedDB when there is one, else memory.
export function createOlderStore(ns: string): OlderStore {
  return typeof indexedDB !== 'undefined' ? new IDBOlderStore(ns) : new MemoryOlderStore();
}
