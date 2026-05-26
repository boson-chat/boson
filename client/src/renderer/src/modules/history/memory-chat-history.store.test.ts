import { describe, it, expect } from 'vitest';
import { MemoryChatHistoryStore } from './memory-chat-history.store';
import { HISTORY_CAP } from './chat-history.types';
import type { ChatMessage, HistoryScope } from './chat-history.types';

function msg(id: string, ts: number, text = `t${id}`): ChatMessage {
  return { id, kind: 'message', from: 'alice', text, timestamp: ts };
}

function scope(over: Partial<HistoryScope> = {}): HistoryScope {
  return { userId: 'u1', serverId: 's1', channel: '#general', ...over };
}

describe('MemoryChatHistoryStore', () => {
  it('load() returns an empty array when nothing has been appended', async () => {
    const store = new MemoryChatHistoryStore();
    expect(await store.load(scope())).toEqual([]);
  });

  it('append() + load() round-trips a single message', async () => {
    const store = new MemoryChatHistoryStore();
    await store.append(scope(), msg('1', 1000, 'hello'));
    const loaded = await store.load(scope());
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual({ id: '1', kind: 'message', from: 'alice', text: 'hello', timestamp: 1000 });
  });

  it('preserves insertion order across multiple appends', async () => {
    const store = new MemoryChatHistoryStore();
    await store.append(scope(), msg('1', 1000));
    await store.append(scope(), msg('2', 2000));
    await store.append(scope(), msg('3', 3000));
    const loaded = await store.load(scope());
    expect(loaded.map((m) => m.id)).toEqual(['1', '2', '3']);
  });

  it('caps at HISTORY_CAP messages and evicts the oldest', async () => {
    const store = new MemoryChatHistoryStore();
    // Append cap + 50 messages — first 50 should evict.
    for (let i = 0; i < HISTORY_CAP + 50; i++) {
      await store.append(scope(), msg(String(i), i * 1000));
    }
    const loaded = await store.load(scope());
    expect(loaded).toHaveLength(HISTORY_CAP);
    expect(loaded[0]!.id).toBe('50');
    expect(loaded[loaded.length - 1]!.id).toBe(String(HISTORY_CAP + 49));
  });

  it('clear() empties only the targeted scope', async () => {
    const store = new MemoryChatHistoryStore();
    await store.append(scope({ channel: '#a' }), msg('1', 1000));
    await store.append(scope({ channel: '#b' }), msg('2', 2000));
    await store.clear(scope({ channel: '#a' }));
    expect(await store.load(scope({ channel: '#a' }))).toEqual([]);
    expect(await store.load(scope({ channel: '#b' }))).toHaveLength(1);
  });

  it('isolates messages across servers under the same user', async () => {
    const store = new MemoryChatHistoryStore();
    await store.append(scope({ serverId: 's1' }), msg('1', 1000, 's1msg'));
    await store.append(scope({ serverId: 's2' }), msg('2', 2000, 's2msg'));
    const s1 = await store.load(scope({ serverId: 's1' }));
    const s2 = await store.load(scope({ serverId: 's2' }));
    expect(s1.map((m) => m.text)).toEqual(['s1msg']);
    expect(s2.map((m) => m.text)).toEqual(['s2msg']);
  });

  it('isolates messages across users on the same server + channel', async () => {
    const store = new MemoryChatHistoryStore();
    await store.append(scope({ userId: 'u1' }), msg('1', 1000, 'u1msg'));
    await store.append(scope({ userId: 'u2' }), msg('2', 2000, 'u2msg'));
    const u1 = await store.load(scope({ userId: 'u1' }));
    const u2 = await store.load(scope({ userId: 'u2' }));
    expect(u1.map((m) => m.text)).toEqual(['u1msg']);
    expect(u2.map((m) => m.text)).toEqual(['u2msg']);
  });

  it('wipeAllForUser() only affects the targeted user', async () => {
    const store = new MemoryChatHistoryStore();
    await store.append(scope({ userId: 'u1', channel: '#a' }), msg('1', 1000));
    await store.append(scope({ userId: 'u1', channel: '#b' }), msg('2', 2000));
    await store.append(scope({ userId: 'u2', channel: '#a' }), msg('3', 3000));

    await store.wipeAllForUser('u1');

    expect(await store.load(scope({ userId: 'u1', channel: '#a' }))).toEqual([]);
    expect(await store.load(scope({ userId: 'u1', channel: '#b' }))).toEqual([]);
    // u2's data survives.
    expect(await store.load(scope({ userId: 'u2', channel: '#a' }))).toHaveLength(1);
  });

  it('load() returns a copy — caller mutations do not affect future loads', async () => {
    const store = new MemoryChatHistoryStore();
    await store.append(scope(), msg('1', 1000));
    const first = await store.load(scope());
    first.length = 0; // mutate the returned array
    const second = await store.load(scope());
    expect(second).toHaveLength(1);
  });
});
