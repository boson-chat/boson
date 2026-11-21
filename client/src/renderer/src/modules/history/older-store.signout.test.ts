import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IDBOlderStore, clearOlderSpill } from './older-store';
import type { ChatMessage } from '../chat/chat.types';

const msg = (i: number): ChatMessage => ({ id: `m${i}`, kind: 'message', from: 'bob', text: `line ${i}`, timestamp: 1000 + i });

async function rows(idb: IDBFactory): Promise<number> {
  const db = await new Promise<IDBDatabase>((res, rej) => { const r = idb.open('boson-chat-spill', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    return await new Promise<number>((res) => { const q = db.transaction('older').objectStore('older').count(); q.onsuccess = () => res(q.result); });
  } finally { db.close(); }
}

describe('clearOlderSpill (sign-out)', () => {
  it("forgets every held line on disk and in memory, and what wasn't written yet", async () => {
    const idb = new IDBFactory();
    const s = new IDBOlderStore('srv', 100, idb);
    s.put('#a', [msg(1), msg(2)]);
    await s.flush();
    expect(await rows(idb)).toBe(2);
    s.put('#a', [msg(3)]); // still buffered
    await clearOlderSpill(idb);
    expect(s.count('#a')).toBe(0);
    expect(await rows(idb)).toBe(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(await rows(idb)).toBe(0);
  });
});
