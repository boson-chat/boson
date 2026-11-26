// A late line older than what's on screen (a bouncer's replay after a
// reconnect, a backlog that brings a line this device never got) while
// older lines are held aside in the OlderStore (memory windows): it must
// come back in time order on scroll-up or when the conversation is opened,
// not stuck below newer lines that were held aside. Seen on a phone through
// evrd: "test" at 08:04 shown under 08:14, 08:34 and ChanServ's +qo rows.
import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryOlderStore, type OlderStore } from '../history/older-store';

const T0 = Date.parse('2026-11-26T08:00:00Z');
const at = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000).toISOString();

function setup(caps = 'batch server-time draft/chathistory', asyncStore = false) {
  let listener: EventListener | null = null;
  const noop = () => {};
  const session = {
    serverId: 'srv', join: noop, part: noop, names: noop, tagmsg: noop, list: noop, away: noop,
    nick: noop, nickservIdentify: noop, privmsg: noop, raw: noop,
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => noop, onServicesFramework: () => noop, servicesFramework: () => null,
  } as unknown as ServerSession;
  const older: OlderStore = new MemoryOlderStore();
  if (asyncStore) {
    const sync = older.takeNewest.bind(older) as (k: string, n: number) => ReturnType<MemoryOlderStore['takeNewest']>;
    older.takeNewest = (k: string, n: number) => Promise.resolve(sync(k, n));
  }
  const chat = new ChatService(session, 'TheLion', undefined, { olderStore: older, windows: { active: 200, tail: 50, page: 100 } });
  chat.attach();
  const emit = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>) => listener?.({ From: '', Target: '', Message: '', Raw: '', ...e });
  emit({ Kind: 'CAP', Message: caps, Args: ['ACK'] });
  emit({ Kind: '001', From: 'irc', Target: 'TheLion' });
  const say = (from: string, text: string, time: string, batch?: string) =>
    emit({ Kind: 'PRIVMSG', From: from, Target: '#team', Message: text, Tags: { time, ...(batch ? { batch } : {}) } });
  const ch = () => chat.getState().channels.find((c) => c.name === '#team')!;
  const texts = () => ch().messages.map((m) => m.text);
  const times = () => ch().messages.map((m) => m.timestamp);
  return { chat, emit, say, ch, texts, times, older };
}

const isSorted = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! <= x);

// #team gets "08:14", "08:34", then enough newer traffic that those two
// leave memory (it isn't on screen: a 50-line tail).
function beforeReconnect(t: ReturnType<typeof setup>) {
  t.emit({ Kind: 'JOIN', From: 'TheLion', Target: '#team' });
  t.emit({ Kind: 'JOIN', From: 'TheLion', Target: '#other' });
  t.chat.setForeground(true);
  t.chat.setActive('#other');
  t.say('TheLion', "It's now automated", at(14));
  t.say('jrmu', 'cool', at(34));
  for (let i = 0; i < 60; i++) t.say('bot', `noise ${i}`, at(40, i));
  expect(t.older.contains('#team', { id: 'x', kind: 'message', from: 'jrmu', text: 'cool', timestamp: Date.parse(at(34)), serverTime: Date.parse(at(34)) })).toBe(true);
}

describe('a late line older than the lines held aside', () => {
  it('replayed live (no batch) lands in time order when the conversation is opened', () => {
    const t = setup('server-time');
    beforeReconnect(t);
    t.say('TheLion', 'test', at(4, 42));
    t.say('jrmu', 'greetings', at(92));
    t.chat.setActive('#team');
    expect(isSorted(t.times())).toBe(true);
    const all = t.texts();
    expect(all.indexOf('test')).toBeLessThan(all.indexOf("It's now automated"));
    expect(all.indexOf("It's now automated")).toBeLessThan(all.indexOf('cool'));
    expect(all.filter((x) => x === 'test')).toHaveLength(1);
  });

  it('in an attach backlog batch: in time order, and replayed again not shown twice', () => {
    const t = setup();
    beforeReconnect(t);
    const replay = (ref: string) => {
      t.emit({ Kind: 'BATCH', Args: [`+${ref}`, 'chathistory', '#team'] });
      t.say('TheLion', 'test', at(4, 42), ref);
      t.say('TheLion', "It's now automated", at(14), ref);
      t.say('jrmu', 'cool', at(34), ref);
      t.say('jrmu', 'greetings', at(92), ref);
      t.emit({ Kind: 'BATCH', Args: [`-${ref}`] });
    };
    replay('a');
    replay('b');
    t.chat.setActive('#team');
    expect(isSorted(t.times())).toBe(true);
    const all = t.texts();
    expect(all.indexOf('test')).toBeLessThan(all.indexOf('cool'));
    for (const x of ['test', 'cool', "It's now automated", 'greetings']) expect(all.filter((y) => y === x)).toHaveLength(1);
  });

  it('on the open conversation: scrolling back brings it back in order (async store too)', async () => {
    for (const asyncStore of [false, true]) {
      const t = setup('server-time', asyncStore);
      t.emit({ Kind: 'JOIN', From: 'TheLion', Target: '#team' });
      t.chat.setForeground(true);
      t.chat.setActive('#team');
      t.say('TheLion', "It's now automated", at(14));
      t.say('jrmu', 'cool', at(34));
      for (let i = 0; i < 250; i++) t.say('bot', `noise ${i}`, at(40, i));
      // Scrolled up reading: live lines grow the window instead of trimming.
      t.chat.setViewport('#team', false);
      const firstShown = t.ch().messages[0]!.id;
      // The late line belongs above everything in memory: it goes with the
      // held lines, so what's on screen doesn't change.
      t.say('TheLion', 'test', at(4, 42));
      expect(t.ch().messages[0]!.id).toBe(firstShown);
      expect(t.texts()).not.toContain('test');
      t.chat.loadOlderHistory('#team');
      await Promise.resolve(); await Promise.resolve();
      expect(isSorted(t.times())).toBe(true);
      const all = t.texts();
      expect(all.indexOf('test')).toBeGreaterThanOrEqual(0);
      expect(all.indexOf('test')).toBeLessThan(all.indexOf('cool'));
    }
  });

  it('a backlog landing while an async store (IndexedDB) is still filling the window', async () => {
    const t = setup('batch server-time draft/chathistory', true);
    beforeReconnect(t);
    // Opened (the reconnect keeps it on screen): the window fills from the
    // store, which answers later…
    t.chat.setActive('#team');
    // …and the attach's backlog lands first, with a line this device never got.
    t.emit({ Kind: 'BATCH', Args: ['+r', 'chathistory', '#team'] });
    t.say('TheLion', 'test', at(4, 42), 'r');
    t.say('jrmu', 'cool', at(34), 'r');
    t.say('jrmu', 'greetings', at(92), 'r');
    t.emit({ Kind: 'BATCH', Args: ['-r'] });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // Whatever is shown is in time order; scrolling back gets the rest in order.
    expect(isSorted(t.times())).toBe(true);
    t.chat.setViewport('#team', false);
    while (t.older.has('#team')) {
      t.chat.loadOlderHistory('#team');
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    expect(isSorted(t.times())).toBe(true);
    const all = t.texts();
    expect(all.indexOf('test')).toBeLessThan(all.indexOf("It's now automated"));
    for (const x of ['test', 'cool', 'greetings']) expect(all.filter((y) => y === x)).toHaveLength(1);
  });
});
