import { describe, expect, it } from 'vitest';
import { hash53, lineIdentity, MemoryOlderStore } from './older-store';
import type { ChatMessage } from '../chat/chat.types';

const msg = (i: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m${i}`, kind: 'message', from: 'bob', text: `line ${i}`, timestamp: 1000 + i, ...extra });

describe('MemoryOlderStore', () => {
  it('holds lines oldest first and hands back the newest page', () => {
    const s = new MemoryOlderStore();
    s.put('#a', [msg(3), msg(1), msg(2)]);
    expect(s.count('#a')).toBe(3);
    expect(s.takeNewest('#a', 2).map((m) => m.text)).toEqual(['line 2', 'line 3']);
    expect(s.count('#a')).toBe(1);
    expect(s.takeNewest('#a', 5).map((m) => m.text)).toEqual(['line 1']);
    expect(s.has('#a')).toBe(false);
  });

  it('skips lines it already holds, and knows which it holds', () => {
    const s = new MemoryOlderStore();
    s.put('#a', [msg(1), msg(2)]);
    s.put('#a', [msg(2, { id: 'other id' }), msg(3)]);
    expect(s.count('#a')).toBe(3);
    expect(s.contains('#a', msg(2, { id: 'x' }))).toBe(true);
    expect(s.contains('#b', msg(2))).toBe(false);
    // A msgid is the identity when there is one.
    s.put('#a', [msg(9, { msgid: 'abc' }), msg(10, { msgid: 'abc', text: 'edited' })]);
    expect(s.count('#a')).toBe(4);
    // Taken back out: no longer held.
    s.takeNewest('#a', 10);
    expect(s.contains('#a', msg(2))).toBe(false);
  });

  it('keeps the newest `cap` lines per conversation', () => {
    const s = new MemoryOlderStore(3);
    s.put('#a', [msg(1), msg(2), msg(3), msg(4), msg(5)]);
    expect(s.count('#a')).toBe(3);
    expect(s.takeNewest('#a', 10).map((m) => m.text)).toEqual(['line 3', 'line 4', 'line 5']);
  });

  it('drop forgets a conversation', () => {
    const s = new MemoryOlderStore();
    s.put('#a', [msg(1)]);
    s.put('#b', [msg(1)]);
    s.drop('#a');
    expect(s.has('#a')).toBe(false);
    expect(s.has('#b')).toBe(true);
  });
});

describe('hash53 / lineIdentity', () => {
  it('is stable and spreads', () => {
    expect(hash53('abc')).toBe(hash53('abc'));
    const seen = new Set<number>();
    for (let i = 0; i < 100_000; i++) seen.add(hash53(lineIdentity(msg(i))));
    expect(seen.size).toBe(100_000);
    expect(Number.isSafeInteger(hash53('x'))).toBe(true);
  });
});
