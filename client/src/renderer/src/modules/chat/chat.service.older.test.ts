// Scroll-back on a bouncer with no history command (a plain ZNC): what it
// replayed beyond the in-memory cap is kept aside and handed back a page at
// a time on scroll-up, instead of being thrown away.
import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

function setup(caps = 'batch server-time') {
  let listener: EventListener | null = null;
  const noop = () => {};
  const raws: string[] = [];
  const privmsgs: string[] = [];
  const session = {
    serverId: 'srv', join: noop, part: noop, names: noop, tagmsg: noop, list: noop, away: noop,
    nick: noop, nickservIdentify: noop,
    privmsg: (t: string, m: string) => { privmsgs.push(`${t} ${m}`); },
    raw: (l: string) => { raws.push(l); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => noop, onServicesFramework: () => noop, servicesFramework: () => null,
  } as unknown as ServerSession;
  const chat = new ChatService(session, 'Nyan', undefined, { bouncer: true });
  chat.attach();
  const emit = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>) => listener?.({ From: '', Target: '', Message: '', Raw: '', ...e });
  emit({ Kind: 'CAP', Message: caps, Args: ['ACK'] });
  emit({ Kind: '001', From: 'irc.znc.in', Target: 'Nyan' });
  emit({ Kind: 'JOIN', From: 'Nyan', Target: '#big' });
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  const replay = (ref: string, n: number) => {
    emit({ Kind: 'BATCH', Args: [`+${ref}`, 'znc.in/playback', '#big'] });
    for (let i = 0; i < n; i++) {
      emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#big', Message: `line ${i}`,
        Tags: { batch: ref, time: new Date(base + i * 1000).toISOString() } });
    }
    emit({ Kind: 'BATCH', Args: [`-${ref}`] });
  };
  const live = (text: string) => emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#big', Message: text });
  const ch = () => chat.getState().channels.find((c) => c.name === '#big')!;
  const lines = () => ch().messages.map((m) => m.text).filter((t) => t.startsWith('line '));
  return { chat, emit, replay, live, ch, lines, raws, privmsgs };
}

describe('scroll-back from lines held aside (plain ZNC)', () => {
  it('a 2000-line replay shows the newest 1500 and offers the rest on scroll-up, 50 at a time', () => {
    const t = setup();
    t.replay('a', 2000);
    // 1500 in memory: the newest 1499 lines and "You joined #big".
    expect(t.ch().messages).toHaveLength(1500);
    expect(t.lines()[0]).toBe('line 501');
    expect(t.chat.getState().serverInfo.scrollbackAvailable).toBe(true);
    expect(t.ch().history).toEqual({ loading: false, exhausted: false });

    t.chat.loadOlderHistory('#big');
    expect(t.ch().messages).toHaveLength(1550);
    expect(t.lines()[0]).toBe('line 451');
    expect(t.lines()[49]).toBe('line 500');
    expect(t.ch().history?.exhausted).toBe(false);
    // Nothing was asked of the server.
    expect(t.raws.filter((r) => r.startsWith('CHATHISTORY'))).toEqual([]);
    expect(t.privmsgs).toEqual([]);
  });

  it('runs out where the replay started', () => {
    const t = setup();
    t.replay('a', 1600);
    t.chat.loadOlderHistory('#big');
    t.chat.loadOlderHistory('#big');
    t.chat.loadOlderHistory('#big');
    expect(t.lines()).toHaveLength(1600);
    expect(t.lines()[0]).toBe('line 0');
    expect(t.ch().history?.exhausted).toBe(true);
    t.chat.loadOlderHistory('#big'); // no-op once exhausted
    expect(t.lines()).toHaveLength(1600);
  });

  it('revealed lines stay put while live traffic arrives', () => {
    const t = setup();
    t.replay('a', 1600);
    t.chat.loadOlderHistory('#big');
    for (let i = 0; i < 20; i++) t.live(`live ${i}`);
    expect(t.lines()[0]).toBe('line 51');
    expect(t.lines()).toHaveLength(1549);
    expect(t.ch().messages.at(-1)!.text).toBe('live 19');
  });

  it('a small replay with nothing held aside has no more to give', () => {
    const t = setup();
    t.replay('a', 30);
    expect(t.ch().history?.exhausted).toBe(true);
  });

  it('replaying the same buffer again does not duplicate what is held aside', () => {
    const t = setup();
    t.replay('a', 1700);
    t.replay('b', 1700);
    for (let i = 0; i < 5; i++) t.chat.loadOlderHistory('#big');
    const all = t.lines();
    expect(all).toHaveLength(1700);
    expect(new Set(all).size).toBe(1700);
    expect(all[0]).toBe('line 0');
  });

  it('live traffic past the cap is held aside too', () => {
    const t = setup();
    for (let i = 0; i < 1510; i++) t.live(`line ${i}`);
    expect(t.lines()[0]).toBe('line 10'); // the join line was oldest, so trimmed first
    t.chat.loadOlderHistory('#big');
    expect(t.lines()[0]).toBe('line 0');
  });

  it('carries over a reconnect', () => {
    const t = setup();
    t.replay('a', 1600);
    const next = setup().chat;
    next.seedConversations(t.chat.exportConversations());
    next.loadOlderHistory('#big');
    const texts = next.getState().channels.find((c) => c.name === '#big')!.messages.map((m) => m.text);
    // The new connection's own "You joined" pushed one more line aside.
    expect(texts.filter((x) => x.startsWith('line '))[0]).toBe('line 52');
  });

  it('a server with real history still uses it', () => {
    const t = setup('batch server-time chathistory');
    t.replay('a', 1600);
    t.chat.loadOlderHistory('#big');
    expect(t.raws.some((r) => r.startsWith('CHATHISTORY BEFORE #big'))).toBe(true);
  });
});
