import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalStorageMemoStore } from './memo.store';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

describe('LocalStorageMemoStore', () => {
  let storage: Storage;
  let store: LocalStorageMemoStore;

  beforeEach(() => {
    storage = memStorage();
    store = new LocalStorageMemoStore('u1', storage);
  });

  it('starts empty for a fresh user', () => {
    expect(store.list()).toEqual([]);
    expect(store.unreadCount()).toBe(0);
  });

  it('appends entries with unread=true and id assigned', () => {
    const id = store.append({
      serverId: 'libera',
      serverName: 'Libera.Chat',
      text: 'Memo from alice: hi!',
      timestamp: 1700000000000,
    });
    expect(id).toBeTruthy();
    const memos = store.list();
    expect(memos).toHaveLength(1);
    expect(memos[0]).toMatchObject({ id, read: false, serverId: 'libera', text: 'Memo from alice: hi!' });
    expect(store.unreadCount()).toBe(1);
  });

  it('subscribers receive the current list synchronously and on every mutation', () => {
    const seen: number[] = [];
    const off = store.subscribe((m) => { seen.push(m.length); });
    // Initial fire.
    expect(seen).toEqual([0]);
    store.append({ serverId: 's1', serverName: 's1', text: 'a', timestamp: 1 });
    store.append({ serverId: 's1', serverName: 's1', text: 'b', timestamp: 2 });
    store.markAllRead();
    off();
    // Initial + 2 appends + 1 markAllRead = 4 emits.
    expect(seen).toEqual([0, 1, 2, 2]);
    // After unsubscribe, no further fires.
    store.append({ serverId: 's1', serverName: 's1', text: 'c', timestamp: 3 });
    expect(seen).toEqual([0, 1, 2, 2]);
  });

  it('persists across instances for the same userId', () => {
    store.append({ serverId: 's1', serverName: 's1', text: 'persisted', timestamp: 1 });
    // New instance reading the same backing storage.
    const next = new LocalStorageMemoStore('u1', storage);
    expect(next.list()).toHaveLength(1);
    expect(next.list()[0]?.text).toBe('persisted');
  });

  it('scopes per userId — user A and user B never see each other', () => {
    store.append({ serverId: 's1', serverName: 's1', text: 'for u1', timestamp: 1 });
    const other = new LocalStorageMemoStore('u2', storage);
    expect(other.list()).toEqual([]);
    other.append({ serverId: 's1', serverName: 's1', text: 'for u2', timestamp: 2 });
    expect(store.list()).toHaveLength(1);
    expect(other.list()).toHaveLength(1);
  });

  it('setUserId switches the visible inbox without losing the other user\'s memos', () => {
    store.append({ serverId: 's1', serverName: 's1', text: 'u1 memo', timestamp: 1 });
    store.setUserId('u2');
    expect(store.list()).toEqual([]);
    store.append({ serverId: 's1', serverName: 's1', text: 'u2 memo', timestamp: 2 });
    expect(store.list()).toHaveLength(1);
    store.setUserId('u1');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.text).toBe('u1 memo');
  });

  it('markAllRead flips every entry; second call is a no-op (no emit)', () => {
    store.append({ serverId: 's1', serverName: 's1', text: 'a', timestamp: 1 });
    store.append({ serverId: 's1', serverName: 's1', text: 'b', timestamp: 2 });
    expect(store.unreadCount()).toBe(2);
    let emits = 0;
    store.subscribe(() => { emits += 1; });
    // Synchronous initial emit on subscribe.
    expect(emits).toBe(1);
    store.markAllRead();
    expect(emits).toBe(2);
    expect(store.unreadCount()).toBe(0);
    store.markAllRead();
    // No emit on the no-op second call.
    expect(emits).toBe(2);
  });

  it('caps retention at MAX_ENTRIES (500) — oldest are evicted', () => {
    // Append 510; the first 10 should drop.
    for (let i = 0; i < 510; i++) {
      store.append({ serverId: 's1', serverName: 's1', text: `m${i}`, timestamp: i });
    }
    const memos = store.list();
    expect(memos).toHaveLength(500);
    expect(memos[0]?.text).toBe('m10');
    expect(memos[memos.length - 1]?.text).toBe('m509');
  });

  it('clear() wipes the inbox and emits', () => {
    store.append({ serverId: 's1', serverName: 's1', text: 'a', timestamp: 1 });
    let listLen = -1;
    store.subscribe((m) => { listLen = m.length; });
    store.clear();
    expect(store.list()).toEqual([]);
    expect(listLen).toBe(0);
  });

  it('recovers from corrupt JSON in storage by starting empty', () => {
    storage.setItem('boson.memos.u1', '{not-valid-json');
    const fresh = new LocalStorageMemoStore('u1', storage);
    expect(fresh.list()).toEqual([]);
    // And subsequent appends work.
    fresh.append({ serverId: 's1', serverName: 's1', text: 'a', timestamp: 1 });
    expect(fresh.list()).toHaveLength(1);
  });

  it('isolates subscriber exceptions — one throwing listener does not block the others', () => {
    const seen: number[] = [];
    store.subscribe(() => { throw new Error('boom'); });
    store.subscribe((m) => { seen.push(m.length); });
    store.append({ serverId: 's1', serverName: 's1', text: 'a', timestamp: 1 });
    // The second listener still received the post-append emit.
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('falls back to in-memory operation when storage.setItem throws (quota exceeded)', () => {
    // Simulate a quota error by swapping the storage's setItem.
    const quotaStorage = memStorage();
    quotaStorage.setItem = vi.fn(() => { throw new Error('QUOTA_EXCEEDED'); });
    const s = new LocalStorageMemoStore('u1', quotaStorage);
    expect(() => s.append({ serverId: 's1', serverName: 's1', text: 'a', timestamp: 1 })).not.toThrow();
    expect(s.list()).toHaveLength(1);
  });
});
