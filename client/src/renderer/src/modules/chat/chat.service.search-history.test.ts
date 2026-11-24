// The full-page search's own history requests (fetchHistory): CHATHISTORY
// BEFORE / AROUND answered in batches of their own, handed back to the
// caller and kept out of the conversation; and revealHistory, which puts
// lines into the conversation when a result is opened there.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

function setup(caps = 'batch server-time message-tags chathistory', isupport: string[] = []) {
  let listener: EventListener | null = null;
  const noop = () => {};
  const raws: string[] = [];
  const session = {
    serverId: 'srv', join: noop, part: noop, names: noop, tagmsg: noop, list: noop, away: noop,
    nick: noop, nickservIdentify: noop, privmsg: noop,
    raw: (l: string) => { raws.push(l); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => noop, onServicesFramework: () => noop, servicesFramework: () => null,
  } as unknown as ServerSession;
  const chat = new ChatService(session, 'me');
  chat.attach();
  const emit = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>) => listener?.({ From: '', Target: '', Message: '', Raw: '', ...e });
  emit({ Kind: 'CAP', Message: caps, Args: ['ACK'] });
  emit({ Kind: '001', From: 'irc.test', Target: 'me' });
  if (isupport.length) emit({ Kind: '005', From: 'irc.test', Target: 'me', Args: ['me', ...isupport] });
  emit({ Kind: 'JOIN', From: 'me', Target: '#dev' });
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  // A chathistory batch for #dev: lines [from, to).
  const batch = (ref: string, from: number, to: number, target = '#dev') => {
    emit({ Kind: 'BATCH', Args: [`+${ref}`, 'chathistory', target] });
    for (let i = from; i < to; i++) {
      emit({ Kind: 'PRIVMSG', From: 'bob', Target: target, Message: `old ${i}`,
        Tags: { batch: ref, time: new Date(base + i * 1000).toISOString(), msgid: `id${i}` } });
    }
    emit({ Kind: 'BATCH', Args: [`-${ref}`] });
  };
  const ch = () => chat.getState().channels.find((c) => c.name === '#dev')!;
  const texts = () => ch().messages.map((m) => m.text);
  return { chat, emit, batch, ch, texts, raws, base };
}

afterEach(() => { vi.useRealTimers(); });

describe('fetchHistory', () => {
  it('sends CHATHISTORY BEFORE a time or AROUND a msgid, at most the server maximum', async () => {
    const t = setup(undefined, ['CHATHISTORY=200']);
    expect(t.chat.historyQueryLimit()).toBe(200);
    void t.chat.fetchHistory('#dev', 'BEFORE', { timestamp: t.base }, 500).catch(() => {});
    void t.chat.fetchHistory('#dev', 'AROUND', { msgid: 'abc' }, 50).catch(() => {});
    const sent = t.raws.filter((r) => r.startsWith('CHATHISTORY') && !r.includes('LATEST') && !r.includes('TARGETS'));
    expect(sent).toEqual([
      `CHATHISTORY BEFORE #dev timestamp=${new Date(t.base).toISOString()} 200`,
      'CHATHISTORY AROUND #dev msgid=abc 50',
    ]);
  });

  it('without a stated maximum, asks 100 at a time', () => {
    expect(setup().chat.historyQueryLimit()).toBe(100);
  });

  it('its batch comes back to the caller, oldest first, and stays out of the conversation', async () => {
    const t = setup();
    t.batch('latest', 900, 910); // the join's own backlog
    const before = t.texts();
    const unread = t.ch().unread;
    const p = t.chat.fetchHistory('#dev', 'BEFORE', { timestamp: t.base + 900_000 }, 100);
    t.batch('q1', 800, 900);
    const got = await p;
    expect(got).toHaveLength(100);
    expect(got[0]!.text).toBe('old 800');
    expect(got[99]!.msgid).toBe('id899');
    expect(t.texts()).toEqual(before);
    expect(t.ch().unread).toBe(unread);
    expect(t.ch().history?.loading ?? false).toBe(false);
  });

  it("answers are told apart from the conversation's own scroll-back, in the order asked", async () => {
    const t = setup();
    t.batch('latest', 900, 950); // a full page: there's more to scroll back to
    const p = t.chat.fetchHistory('#dev', 'BEFORE', { timestamp: t.base }, 100);
    t.chat.loadOlderHistory('#dev'); // asked after the search
    expect(t.ch().history?.loading).toBe(true);
    t.batch('a', 700, 750); // the search's
    t.batch('b', 850, 900); // the scroll-back's
    expect((await p).map((m) => m.text)[0]).toBe('old 700');
    expect(t.texts()[0]).toBe('old 850');
    expect(t.texts()).not.toContain('old 700');
  });

  it('a scroll-back asked first gets the first batch', async () => {
    const t = setup();
    t.batch('latest', 900, 950);
    t.chat.loadOlderHistory('#dev');
    expect(t.ch().history?.loading).toBe(true);
    const p = t.chat.fetchHistory('#dev', 'BEFORE', { timestamp: t.base }, 100);
    t.batch('a', 850, 900);
    t.batch('b', 700, 750);
    expect((await p)[0]!.text).toBe('old 700');
    expect(t.texts()[0]).toBe('old 850');
  });

  it('a DM target matches whatever its case in the reply', async () => {
    const t = setup();
    const p = t.chat.fetchHistory('Bob', 'BEFORE', { timestamp: t.base }, 10);
    t.batch('d', 1, 3, 'bob');
    expect(await p).toHaveLength(2);
  });

  it('rejects without CHATHISTORY', async () => {
    const t = setup('batch server-time');
    expect(t.chat.chathistorySupported()).toBe(false);
    await expect(t.chat.fetchHistory('#dev', 'BEFORE', { timestamp: 1 }, 10)).rejects.toThrow(/does not keep history/);
  });

  it('rejects on a 421 (the command is unknown after all)', async () => {
    const t = setup();
    const p = t.chat.fetchHistory('#dev', 'BEFORE', { timestamp: 1 }, 10);
    t.emit({ Kind: '421', Args: ['CHATHISTORY'], Message: 'Unknown command' });
    await expect(p).rejects.toThrow(/does not support CHATHISTORY/);
    expect(t.chat.chathistorySupported()).toBe(false);
  });

  it('rejects on a FAIL for its target', async () => {
    const t = setup();
    const p = t.chat.fetchHistory('#dev', 'AROUND', { msgid: 'x' }, 10);
    t.emit({ Kind: 'FAIL', Args: ['CHATHISTORY', 'INVALID_PARAMS', 'AROUND', '#dev'], Message: 'Invalid parameters' });
    await expect(p).rejects.toThrow('Invalid parameters');
  });

  it('rejects when the server never answers', async () => {
    vi.useFakeTimers();
    const t = setup();
    const p = t.chat.fetchHistory('#dev', 'BEFORE', { timestamp: 1 }, 10);
    const done = expect(p).rejects.toThrow('No response from server');
    vi.advanceTimersByTime(15_001);
    await done;
    // A late batch then goes to the conversation as usual.
    t.batch('late', 1, 3);
  });

  it('rejects when the connection is torn down', async () => {
    const t = setup();
    const p = t.chat.fetchHistory('#dev', 'BEFORE', { timestamp: 1 }, 10);
    t.chat.detach();
    await expect(p).rejects.toThrow('Disconnected');
  });
});

describe('revealHistory', () => {
  it('merges lines into the conversation by time, without copies, and returns the focus line\'s id', () => {
    const t = setup();
    t.batch('latest', 900, 905);
    const lines = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}`, kind: 'message' as const, from: 'bob', text: `old ${898 + i}`, timestamp: t.base + (898 + i) * 1000, msgid: `id${898 + i}`,
    }));
    const unread = t.ch().unread;
    const id = t.chat.revealHistory('#dev', lines, lines[0]!);
    expect(id).toBe('f0');
    const olds = t.texts().filter((x) => x.startsWith('old '));
    expect(olds).toEqual(['old 898', 'old 899', 'old 900', 'old 901', 'old 902', 'old 903', 'old 904']);
    expect(t.ch().unread).toBe(unread);
    // A line already shown: the conversation's own copy.
    const shown = t.ch().messages.find((m) => m.msgid === 'id902')!;
    expect(t.chat.revealHistory('#dev', [lines[4]!], lines[4]!)).toBe(shown.id);
    // A line given twice is added once.
    t.chat.revealHistory('#dev', [lines[0]!, { ...lines[0]!, id: 'dup' }], lines[0]!);
    expect(t.texts().filter((x) => x === 'old 898')).toHaveLength(1);
  });

  it('null for a conversation that is gone', () => {
    const t = setup();
    expect(t.chat.revealHistory('#nope', [], { id: 'x', kind: 'message', from: 'a', text: 'b', timestamp: 1 })).toBeNull();
  });
});
