// Memory windows: the conversation on screen keeps ~200 lines while it's
// read at the bottom, the others a short tail; the rest goes to the
// OlderStore and comes back on scroll-up (then from the server). Unread and
// mention counters don't depend on what's in memory.
import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryOlderStore, type OlderStore } from '../history/older-store';

function setup(caps = 'batch server-time') {
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
  const older: OlderStore = new MemoryOlderStore();
  const chat = new ChatService(session, 'me', undefined, { olderStore: older, windows: { active: 200, tail: 50, page: 100 } });
  chat.attach();
  const emit = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>) => listener?.({ From: '', Target: '', Message: '', Raw: '', ...e });
  emit({ Kind: 'CAP', Message: caps, Args: ['ACK'] });
  emit({ Kind: '001', From: 'irc', Target: 'me' });
  let t = Date.now() + 1000;
  const say = (ch: string, n: number, text = 'line', from = 'bob') => {
    for (let i = 0; i < n; i++) {
      emit({ Kind: 'PRIVMSG', From: from, Target: ch, Message: `${text} ${i}`, Tags: { time: new Date(t += 1000).toISOString() } });
    }
  };
  const ch = (name: string) => chat.getState().channels.find((c) => c.name === name)!;
  const texts = (name: string) => ch(name).messages.map((m) => m.text);
  return { chat, emit, say, ch, texts, older, raws };
}

describe('memory windows', () => {
  it('a conversation not on screen keeps a tail; the rest is held aside', () => {
    const t = setup();
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#b' });
    t.chat.setForeground(true);
    t.chat.setActive('#a');
    t.say('#b', 300);
    expect(t.ch('#b').messages).toHaveLength(50);
    expect(t.texts('#b').at(-1)).toBe('line 299');
    expect(t.older.count('#b')).toBe(251); // 250 lines + "You joined"
    // Counters count every line, not what's in memory.
    expect(t.ch('#b').unread).toBe(300);
  });

  it('opening it fills it back to the window; leaving trims it to the tail', () => {
    const t = setup();
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#b' });
    t.chat.setForeground(true);
    t.chat.setActive('#a');
    t.say('#b', 300);
    t.chat.setActive('#b');
    expect(t.ch('#b').messages).toHaveLength(200);
    expect(t.texts('#b')[0]).toBe('line 100');
    expect(t.texts('#b').at(-1)).toBe('line 299');
    t.chat.setActive('#a');
    expect(t.ch('#b').messages).toHaveLength(50);
    expect(t.texts('#b')[0]).toBe('line 250');
  });

  it('at the bottom the open conversation stays at its window as lines arrive', () => {
    const t = setup();
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    t.chat.setForeground(true);
    t.chat.setActive('#a');
    t.say('#a', 500);
    expect(t.ch('#a').messages).toHaveLength(200);
    expect(t.texts('#a').at(-1)).toBe('line 499');
  });

  it('scrolled up: pages come back and stay while reading; back at the bottom they go again', () => {
    const t = setup();
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    t.chat.setForeground(true);
    t.chat.setActive('#a');
    t.say('#a', 500);
    t.chat.setViewport('#a', false);
    t.chat.loadOlderHistory('#a');
    t.chat.loadOlderHistory('#a');
    expect(t.ch('#a').messages).toHaveLength(400);
    expect(t.texts('#a')[0]).toBe('line 100');
    // Live lines don't push what's being read off the top.
    t.say('#a', 20, 'live');
    expect(t.ch('#a').messages).toHaveLength(420);
    expect(t.texts('#a')[0]).toBe('line 100');
    // Back at the bottom: released.
    t.chat.setViewport('#a', true);
    expect(t.ch('#a').messages).toHaveLength(200);
    expect(t.texts('#a').at(-1)).toBe('live 19');
    // And available again on the next scroll-up, in order.
    t.chat.setViewport('#a', false);
    t.chat.loadOlderHistory('#a');
    const all = t.texts('#a');
    expect(all).toHaveLength(300);
    expect(all.indexOf('line 499')).toBeLessThan(all.indexOf('live 0'));
  });

  it('runs out of held lines, then asks the server (CHATHISTORY BEFORE the oldest shown)', () => {
    const t = setup('batch server-time chathistory');
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    t.chat.setForeground(true);
    t.chat.setActive('#a');
    t.say('#a', 260);
    t.chat.setViewport('#a', false);
    t.chat.loadOlderHistory('#a');
    expect(t.raws.filter((r) => r.startsWith('CHATHISTORY BEFORE'))).toEqual([]);
    expect(t.older.has('#a')).toBe(false);
    t.chat.loadOlderHistory('#a');
    const pivot = new Date(t.ch('#a').messages[0]!.timestamp).toISOString();
    expect(t.raws.filter((r) => r.startsWith('CHATHISTORY BEFORE'))).toEqual([`CHATHISTORY BEFORE #a timestamp=${pivot} 50`]);
  });

  it('a held line replayed by a bouncer is not shown twice', () => {
    const t = setup();
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#b' });
    t.chat.setForeground(true);
    t.chat.setActive('#b');
    const base = Date.parse('2026-10-01T00:00:00Z');
    const replay = (ref: string) => {
      t.emit({ Kind: 'BATCH', Args: [`+${ref}`, 'znc.in/playback', '#a'] });
      for (let i = 0; i < 120; i++) {
        t.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#a', Message: `old ${i}`, Tags: { batch: ref, time: new Date(base + i * 1000).toISOString() } });
      }
      t.emit({ Kind: 'BATCH', Args: [`-${ref}`] });
    };
    replay('x');
    replay('y');
    expect(t.ch('#a').messages.length + t.older.count('#a')).toBe(121);
  });

  it('/clear forgets held lines too', () => {
    const t = setup();
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    t.chat.setForeground(true);
    t.chat.setActive('#a');
    t.say('#a', 300);
    expect(t.older.has('#a')).toBe(true);
    t.chat.input('/clear');
    expect(t.older.has('#a')).toBe(false);
    expect(t.ch('#a').messages).toHaveLength(0);
  });

  it('an async store (IndexedDB) pages back in when its promise lands', async () => {
    const t = setup();
    const sync = t.older.takeNewest.bind(t.older) as (k: string, n: number) => ReturnType<MemoryOlderStore['takeNewest']>;
    t.older.takeNewest = (k: string, n: number) => Promise.resolve(sync(k, n));
    t.emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    t.chat.setForeground(true);
    t.chat.setActive('#a');
    t.say('#a', 400);
    t.chat.setViewport('#a', false);
    t.chat.loadOlderHistory('#a');
    expect(t.ch('#a').history?.loading).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(t.ch('#a').messages).toHaveLength(300);
    expect(t.ch('#a').history).toEqual({ loading: false, exhausted: false });
  });
});

describe('memory windows: local history', () => {
  it('hydrated history keeps the window; the rest is held for scroll-up', async () => {
    const { MemoryChatHistoryStore } = await import('../history');
    const history = new MemoryChatHistoryStore();
    const scope = { userId: 'u', serverId: 'srv', channel: '#a' };
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 300; i++) {
      await history.append(scope, { id: `p${i}`, kind: 'message', from: 'bob', text: `kept ${i}`, timestamp: base + i * 1000 });
    }
    let listener: EventListener | null = null;
    const noop = () => {};
    const session = {
      serverId: 'srv', join: noop, part: noop, names: noop, tagmsg: noop, list: noop, away: noop,
      nick: noop, nickservIdentify: noop, privmsg: noop, raw: noop,
      onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
      onChannelDirectory: () => noop, onServicesFramework: () => noop, servicesFramework: () => null,
    } as unknown as ServerSession;
    const older = new MemoryOlderStore();
    const chat = new ChatService(session, 'me', { history, scope: { userId: 'u', serverId: 'srv' } }, { olderStore: older, windows: { active: 200, tail: 50, page: 100 } });
    chat.attach();
    const emit = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>) => (listener as EventListener | null)?.({ From: '', Target: '', Message: '', Raw: '', ...e });
    emit({ Kind: '001', From: 'irc', Target: 'me' });
    emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    emit({ Kind: 'JOIN', From: 'me', Target: '#b' });
    chat.setForeground(true);
    chat.setActive('#b');
    await new Promise((r) => setTimeout(r, 10));
    const a = () => chat.getState().channels.find((c) => c.name === '#a')!;
    expect(a().messages).toHaveLength(50);
    expect(older.count('#a')).toBe(251);
    chat.setActive('#a');
    expect(a().messages).toHaveLength(200);
    expect(a().messages.at(-1)?.text).toBe('You joined #a');
  });
});
