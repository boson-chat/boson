import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './chat.types';
import { ThreadIndex, threadReplyTarget } from './threads';

let t = 0;
function msg(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  t += 1000;
  return { id, kind: 'message', from: 'ada', text: id, timestamp: t, msgid: `x-${id}`, ...extra };
}
const reply = (id: string, to: string, extra: Partial<ChatMessage> = {}) => msg(id, { replyTo: `x-${to}`, ...extra });
const ids = (ms: readonly ChatMessage[]) => ms.map((m) => m.id);

describe('ThreadIndex', () => {
  it('roots a chain of replies at its top', () => {
    const ix = new ThreadIndex();
    const list = [msg('a'), reply('b', 'a'), reply('c', 'b'), msg('d'), reply('e', 'c')];
    ix.sync(list);
    expect(ix.rootOf('c')).toBe('a');
    expect(ix.rootOf('e')).toBe('a');
    expect(ix.summary('a')).toMatchObject({ count: 3, lastId: 'e' });
    expect(ids(ix.messages('a'))).toEqual(['a', 'b', 'c', 'e']);
    expect(ix.summary('b')).toBeUndefined();
    expect(ix.threadOf('d')).toBeUndefined();
    expect(ix.threadOf('c')).toBe('a');
  });

  it('links by local id (text replies, servers without message-tags)', () => {
    const ix = new ThreadIndex();
    ix.sync([msg('a', { msgid: undefined }), msg('b', { msgid: undefined, replyToId: 'a' })]);
    expect(ix.summary('a')?.count).toBe(1);
  });

  it('leaves guessed replies out', () => {
    const ix = new ThreadIndex();
    ix.sync([msg('a'), msg('b', { replyToId: 'a', replyGuess: true }), reply('c', 'b')]);
    expect(ix.summary('a')).toBeUndefined();
    // A real reply to the guess threads under the guess, not under `a`.
    expect(ix.rootOf('c')).toBe('b');
    expect(ix.summary('b')?.count).toBe(1);
  });

  it('survives cycles and self-replies', () => {
    const ix = new ThreadIndex();
    const a = msg('a', { replyTo: 'x-b' });
    const b = msg('b', { replyTo: 'x-a' });
    const c = msg('c', { replyTo: 'x-c' });
    ix.sync([a, b, c]);
    // a waits for b; b links under a; a can't then link under b.
    expect(ix.rootOf('b')).toBe('a');
    expect(ix.rootOf('a')).toBe('a');
    expect(ix.summary('a')?.count).toBe(1);
    expect(ix.summary('c')).toBeUndefined();
  });

  it('roots at the oldest known message until the original arrives (prepend)', () => {
    const toggle = vi.fn();
    const ix = new ThreadIndex(toggle);
    const b = reply('b', 'a');
    const c = reply('c', 'b');
    const list1 = [msg('z'), b, c];
    ix.sync(list1);
    expect(ix.rootOf('c')).toBe('b');
    expect(ix.summary('b')?.count).toBe(1);
    expect(toggle).toHaveBeenLastCalledWith('b', true);
    const a = msg('a');
    a.timestamp = 0;
    ix.sync([a, ...list1]);
    expect(ix.rootOf('b')).toBe('a');
    expect(ix.rootOf('c')).toBe('a');
    expect(ix.summary('b')).toBeUndefined();
    expect(ix.summary('a')?.count).toBe(2);
    expect(toggle).toHaveBeenCalledWith('b', false);
    expect(toggle).toHaveBeenCalledWith('a', true);
  });

  it('takes replies that arrived before their original, in any order', () => {
    const ix = new ThreadIndex();
    const a = msg('a');
    const b = reply('b', 'a');
    const c = reply('c', 'b');
    const d = reply('d', 'c');
    ix.sync([d]);
    ix.sync([c, d]);
    expect(ix.rootOf('d')).toBe('c');
    ix.sync([a, c, d]);
    // b still missing: c roots c+d; a has nothing.
    expect(ix.summary('a')).toBeUndefined();
    ix.sync([a, b, c, d]);
    expect(ix.rootOf('d')).toBe('a');
    expect(ix.summary('a')?.count).toBe(3);
    expect(ix.summary('c')).toBeUndefined();
  });

  it('counts appended replies and keeps the summary object until it changes', () => {
    const ix = new ThreadIndex();
    const base = [msg('a'), reply('b', 'a')];
    ix.sync(base);
    const s1 = ix.summary('a');
    ix.sync([...base, msg('q')]);
    expect(ix.summary('a')).toBe(s1);
    ix.sync([...base, msg('q'), reply('r', 'b', { from: 'bob' })]);
    const s2 = ix.summary('a')!;
    expect(s2).not.toBe(s1);
    expect(s2.count).toBe(2);
    expect(s2.nicks).toEqual(['bob', 'ada']);
  });

  it('follows a line replaced in place (an echo giving it a msgid)', () => {
    const ix = new ThreadIndex();
    const a = msg('a');
    const mine = msg('m', { msgid: undefined, replyToId: 'a', pending: true });
    ix.sync([a, mine]);
    expect(ix.rootOf('m')).toBe('a');
    const echoed = { ...mine, msgid: 'x-m', pending: undefined };
    ix.sync([a, echoed]);
    expect(ix.rootOf('m')).toBe('a');
    // A reply to the echoed line by msgid joins the thread.
    ix.sync([a, echoed, reply('n', 'm')]);
    expect(ix.summary('a')?.count).toBe(2);
  });

  it('drops lines trimmed from the front, and their threads', () => {
    const ix = new ThreadIndex();
    const list = [msg('a'), reply('b', 'a'), reply('c', 'b'), msg('d')];
    ix.sync(list);
    ix.sync(list.slice(1));
    // a gone: b roots the rest.
    expect(ix.rootOf('c')).toBe('b');
    expect(ix.summary('b')?.count).toBe(1);
    expect(ix.summary('a')).toBeUndefined();
  });

  it('a removed middle reply splits its chain until it returns', () => {
    const ix = new ThreadIndex();
    const a = msg('a'); const b = reply('b', 'a'); const c = reply('c', 'b');
    ix.sync([a, b, c]);
    ix.sync([a, c]);
    expect(ix.summary('a')).toBeUndefined();
    expect(ix.rootOf('c')).toBe('c');
    ix.sync([a, b, c]);
    expect(ix.summary('a')?.count).toBe(2);
  });

  it('a reply with both links (our own: local id and msgid) counts once', () => {
    const ix = new ThreadIndex();
    ix.sync([msg('a'), msg('b', { replyTo: 'x-a', replyToId: 'a' })]);
    expect(ix.summary('a')?.count).toBe(1);
  });
});

describe('threadReplyTarget', () => {
  it('answers the newest line from someone else, else the newest', () => {
    const a = msg('a', { from: 'bob' });
    const b = msg('b', { from: 'me' });
    expect(threadReplyTarget([a, b], 'me')?.id).toBe('a');
    expect(threadReplyTarget([b], 'me')?.id).toBe('b');
    expect(threadReplyTarget([msg('p', { from: 'me', pending: true })], 'me')).toBeUndefined();
  });
});
