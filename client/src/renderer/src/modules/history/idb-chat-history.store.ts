/* eslint-disable @typescript-eslint/no-explicit-any */
// idb-chat-history.store.ts — IndexedDB-backed ChatHistoryStore.
//
// ============================================================================
// CHANGELOG / SCHEMA
// ============================================================================
// DB name:    "boson-chat-history"
// Version:    1
// Object store: "messages"
//   keyPath:    "_pk" (string)
//     Format: `${userId}::${serverId}::${channel}::${paddedTs}::${id}`
//     The padded timestamp (16-digit, zero-prefixed) sorts lexicographically
//     in the same order as numerically, so an index range over
//     `[userId, serverId, channel]` returns rows in chronological order
//     without an extra sort step.
//   indexes:
//     "byScope" on ['userId', 'serverId', 'channel'] — used by load() to
//     range-scan a single channel's messages.
//
// Future migrations: bump the version, add an onupgradeneeded branch that
// runs in version order (v1 -> v2, v2 -> v3, …). Never assume the user is
// upgrading from the latest predecessor — IDB may call the upgrade handler
// at any prior version.
// ============================================================================

import type { ChatHistoryStore, ChatMessage, HistoryScope } from './chat-history.types';
import { HISTORY_CAP } from './chat-history.types';

const DB_NAME = 'boson-chat-history';
const DB_VERSION = 1;
const STORE = 'messages';

interface StoredRow extends ChatMessage {
  _pk: string;
  userId: string;
  serverId: string;
  channel: string;
}

export class IDBChatHistoryStore implements ChatHistoryStore {
  // Lazy-open the DB on first method call so constructing the store is cheap
  // and doesn't block the renderer on app startup.
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB();
    }
    return this.dbPromise;
  }

  async load(scope: HistoryScope): Promise<ChatMessage[]> {
    const db = await this.getDB();
    return new Promise<ChatMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const index = store.index('byScope');
      const range = IDBKeyRange.only([scope.userId, scope.serverId, scope.channel]);
      const out: ChatMessage[] = [];
      const req = index.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const row = cursor.value as StoredRow;
          out.push(rowToMessage(row));
          cursor.continue();
        } else {
          // Cursor traverses in primary-key order (which encodes timestamp),
          // so out[] is already ascending. If somehow we exceeded the cap
          // (shouldn't happen — append enforces it), trim the leading slice.
          if (out.length > HISTORY_CAP) {
            resolve(out.slice(out.length - HISTORY_CAP));
          } else {
            resolve(out);
          }
        }
      };
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  async append(scope: HistoryScope, msg: ChatMessage): Promise<void> {
    const db = await this.getDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const row: StoredRow = {
        _pk: makePk(scope, msg),
        userId: scope.userId,
        serverId: scope.serverId,
        channel: scope.channel,
        ...msg,
      };
      const putReq = store.put(row);
      putReq.onerror = () => reject(putReq.error);
      // Once the put succeeds, scan the scope index for the count and evict
      // the oldest if we've exceeded the cap. All inside the same transaction
      // so the read sees our write.
      putReq.onsuccess = () => {
        const index = store.index('byScope');
        const range = IDBKeyRange.only([scope.userId, scope.serverId, scope.channel]);
        const countReq = index.count(range);
        countReq.onerror = () => reject(countReq.error);
        countReq.onsuccess = () => {
          const excess = countReq.result - HISTORY_CAP;
          if (excess <= 0) return; // commit naturally
          // Walk the cursor in ascending _pk order and delete the oldest N.
          const cursorReq = index.openCursor(range);
          let removed = 0;
          cursorReq.onerror = () => reject(cursorReq.error);
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor || removed >= excess) return;
            cursor.delete();
            removed++;
            cursor.continue();
          };
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }

  async clear(scope: HistoryScope): Promise<void> {
    const db = await this.getDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const index = store.index('byScope');
      const range = IDBKeyRange.only([scope.userId, scope.serverId, scope.channel]);
      const cursorReq = index.openCursor(range);
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }

  async wipeAllForUser(userId: string): Promise<void> {
    const db = await this.getDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      // _pk starts with `${userId}::` — a lexical range "userId::" .. "userId::￿"
      // captures every row for this user across all servers + channels.
      const lower = `${userId}::`;
      // ￿ is the highest BMP code point — anything starting with the
      // prefix sorts below this upper bound.
      const upper = `${userId}::￿`;
      const range = IDBKeyRange.bound(lower, upper, false, false);
      const cursorReq = store.openCursor(range);
      cursorReq.onerror = () => reject(cursorReq.error);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }
}

// ---------- Helpers ----------

function openDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    // Guard for environments without IDB (some Node runners, etc.). The
    // caller of buildApp should fall back to MemoryChatHistoryStore when
    // indexedDB isn't present, but we still defend here.
    const idb: IDBFactory | undefined = (globalThis as any).indexedDB;
    if (!idb) {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: '_pk' });
        store.createIndex('byScope', ['userId', 'serverId', 'channel'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

// Pad timestamp to 16 digits so lexical ordering matches numeric ordering. JS
// timestamps in ms have ~13 digits today; 16 keeps headroom into the year ~33000.
function padTimestamp(ts: number): string {
  const safe = Math.max(0, Math.floor(ts));
  return safe.toString().padStart(16, '0');
}

function makePk(scope: HistoryScope, msg: ChatMessage): string {
  return `${scope.userId}::${scope.serverId}::${scope.channel}::${padTimestamp(msg.timestamp)}::${msg.id}`;
}

function rowToMessage(row: StoredRow): ChatMessage {
  return {
    id: row.id,
    kind: row.kind,
    from: row.from,
    text: row.text,
    timestamp: row.timestamp,
  };
}
