// memory-chat-history.store.ts — in-process ChatHistoryStore for tests and as
// a graceful fallback when IndexedDB is unavailable (e.g. non-Electron sandbox
// or happy-dom's incomplete IDB shim). Mirrors IDBChatHistoryStore semantics:
// the same LAST_N cap, the same scope partitioning, and the same
// wipeAllForUser behaviour.

import type { ChatHistoryStore, ChatMessage, HistoryScope } from './chat-history.types';
import { HISTORY_CAP } from './chat-history.types';

export class MemoryChatHistoryStore implements ChatHistoryStore {
  // key = `${userId}::${serverId}::${channel}` so wipeAllForUser can iterate
  // the keys and drop everything that prefix-matches the user id.
  private readonly data = new Map<string, ChatMessage[]>();

  async load(scope: HistoryScope): Promise<ChatMessage[]> {
    const arr = this.data.get(scopeKey(scope));
    if (!arr) return [];
    // Return a copy so external mutations don't corrupt our store.
    return arr.slice();
  }

  async append(scope: HistoryScope, msg: ChatMessage): Promise<void> {
    const key = scopeKey(scope);
    const cur = this.data.get(key) ?? [];
    cur.push(msg);
    // Evict oldest until we're back under the cap. Compare on stored
    // insertion order — these arrays are append-only, so index 0 is oldest.
    if (cur.length > HISTORY_CAP) {
      cur.splice(0, cur.length - HISTORY_CAP);
    }
    this.data.set(key, cur);
  }

  async clear(scope: HistoryScope): Promise<void> {
    this.data.delete(scopeKey(scope));
  }

  async wipeAllForUser(userId: string): Promise<void> {
    const prefix = `${userId}::`;
    for (const key of Array.from(this.data.keys())) {
      if (key.startsWith(prefix)) this.data.delete(key);
    }
  }
}

function scopeKey(s: HistoryScope): string {
  return `${s.userId}::${s.serverId}::${s.channel}`;
}
