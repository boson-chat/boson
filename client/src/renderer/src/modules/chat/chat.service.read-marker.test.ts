// Read markers: unread badges that survive closing the app (the backlog that
// comes in on the next attach is compared with how far the user had read),
// and IRCv3 draft/read-marker sync with the server (MARKREAD), so reading on
// one client clears the badge on the others.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';
import {
  LocalStorageReadMarkerBackend,
  READ_MARKERS_CAP,
  READ_MARKERS_PREFIX,
  ReadMarkerStore,
  type ReadMarkerBackend,
} from './read-markers';

interface FakeSession {
  emit(e: IrcEvent): void;
  raws: string[];
}

function makeFakeSession(): FakeSession & Record<string, unknown> {
  let listener: EventListener | null = null;
  const raws: string[] = [];
  return {
    serverId: 'srv-test',
    join: () => {}, part: () => {},
    privmsg: () => {},
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line: string) => { raws.push(line); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e: IrcEvent) => listener?.(e),
    raws,
  };
}

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

let savedStore: ReturnType<typeof getServiceCredentialsStore>;
beforeEach(() => {
  savedStore = getServiceCredentialsStore();
  setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
});
afterEach(() => {
  setServiceCredentialsStore(savedStore);
  vi.useRealTimers();
});

const ev = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>): IrcEvent =>
  ({ From: '', Target: '', Message: '', Raw: '', ...e });

// One "device": the read markers live in `storage` between runs.
interface Device { storage: Storage; backend: ReadMarkerBackend }
const device = (): Device => {
  const storage = memStorage();
  return { storage, backend: new LocalStorageReadMarkerBackend(storage) };
};

// One run of the app on `dev`: a fresh ChatService with the markers reloaded.
function run(dev: Device, caps: string, opts: { bouncer?: boolean } = {}) {
  const session = makeFakeSession();
  const readMarkers = new ReadMarkerStore('u::srv', dev.backend);
  const chat = new ChatService(session as unknown as ServerSession, 'Nyan', undefined, { bouncer: opts.bouncer ?? true, readMarkers });
  const notified: unknown[] = [];
  chat.setNotifier((n) => notified.push(n));
  chat.attach();
  if (caps) session.emit(ev({ Kind: 'CAP', Message: caps, Args: ['ACK'] }));
  session.emit(ev({ Kind: '001', From: 'srv', Target: 'Nyan', Message: 'Welcome' }));
  chat.setForeground(true);
  // The user is reading #home (the first channel joined is shown).
  session.emit(ev({ Kind: 'JOIN', From: 'Nyan', Target: '#home' }));
  return { chat, session, notified, readMarkers };
}

const HISTORY = 'batch server-time chathistory';
const WITH_MARKERS = `${HISTORY} draft/read-marker`;

// Relative to the start of the test, so the same line has the same time in
// both runs of the app.
let base = Date.now();
beforeEach(() => { base = Date.now(); });
const iso = (minutesAgo: number) => new Date(base - minutesAgo * 60_000).toISOString();
const ms = (t: string) => Date.parse(t);

// A JOIN of #lobby answered with `lines` of history ([from, text, time]).
function joinWithHistory(s: FakeSession, chan: string, lines: Array<[string, string, string]>, before?: () => void) {
  s.emit(ev({ Kind: 'JOIN', From: 'Nyan', Target: chan }));
  before?.();
  s.emit(ev({ Kind: 'BATCH', Args: ['+h', 'chathistory', chan] }));
  for (const [from, text, time] of lines) {
    s.emit(ev({ Kind: 'PRIVMSG', From: from, Target: chan, Message: text, Tags: { batch: 'h', time } }));
  }
  s.emit(ev({ Kind: 'BATCH', Args: ['-h'] }));
}

const conv = (chat: ChatService, name: string) => chat.getState().channels.find((c) => c.name === name);
const markreads = (s: FakeSession, target = '#lobby') => s.raws.filter((r) => r.startsWith(`MARKREAD ${target} `));

describe('unread after reopening the app', () => {
  it('counts the backlog newer than where the user stopped reading, without notifying', () => {
    const dev = device();
    const t1 = iso(60);
    const t2 = iso(30);
    // Run 1: the user reads #lobby up to t2, then closes the app.
    const a = run(dev, HISTORY);
    joinWithHistory(a.session, '#lobby', [['alice', 'old', t1], ['bob', 'read this', t2]]);
    a.chat.setActive('#lobby');
    a.chat.setActive('#home');
    a.chat.detach();

    // Run 2: three lines arrived while closed, one of them naming us.
    const b = run(dev, HISTORY);
    joinWithHistory(b.session, '#lobby', [
      ['alice', 'old', t1], ['bob', 'read this', t2],
      ['alice', 'new 1', iso(20)], ['carol', 'hey Nyan', iso(10)], ['bob', 'new 3', iso(5)],
    ]);
    expect(conv(b.chat, '#lobby')).toMatchObject({ unread: 3, mentions: 1 });
    expect(b.notified).toEqual([]);
  });

  it('does not light up a conversation it has never seen read, but counts what comes after', () => {
    const dev = device();
    const a = run(dev, HISTORY);
    joinWithHistory(a.session, '#lobby', [['alice', 'years of history', iso(600)], ['bob', 'more', iso(300)]]);
    expect(conv(a.chat, '#lobby')).toMatchObject({ unread: 0, mentions: 0 });
    // Live, while it isn't open.
    const now = new Date().toISOString();
    a.session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: '#lobby', Message: 'live', Tags: { time: now } }));
    expect(conv(a.chat, '#lobby')?.unread).toBe(1);
    a.chat.detach();

    // Closed before reading it: still unread next time.
    const b = run(dev, HISTORY);
    joinWithHistory(b.session, '#lobby', [['alice', 'years of history', iso(600)], ['bob', 'more', iso(300)], ['alice', 'live', now]]);
    expect(conv(b.chat, '#lobby')?.unread).toBe(1);
  });

  it('opening the conversation clears it and moves the marker', () => {
    const dev = device();
    const a = run(dev, HISTORY);
    joinWithHistory(a.session, '#lobby', [['alice', 'x', iso(5)]]);
    a.session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: '#lobby', Message: 'live', Tags: { time: new Date().toISOString() } }));
    a.chat.setActive('#lobby');
    expect(conv(a.chat, '#lobby')?.unread).toBe(0);
    a.chat.detach();
    const b = run(dev, HISTORY);
    joinWithHistory(b.session, '#lobby', [['alice', 'x', iso(5)], ['alice', 'live', new Date(Date.now() - 1000).toISOString()]]);
    expect(conv(b.chat, '#lobby')?.unread).toBe(0);
  });

  it("never counts the user's own lines", () => {
    const dev = device();
    const a = run(dev, HISTORY);
    joinWithHistory(a.session, '#lobby', [['alice', 'x', iso(60)]]);
    a.chat.setActive('#lobby');
    a.chat.setActive('#home');
    a.chat.detach();
    const b = run(dev, HISTORY);
    joinWithHistory(b.session, '#lobby', [['alice', 'x', iso(60)], ['Nyan', 'from my phone', iso(10)], ['nyan', 'also me', iso(9)]]);
    expect(conv(b.chat, '#lobby')?.unread).toBe(0);
  });

  it('works with a bouncer that only replays its buffer with server-time (no chathistory)', () => {
    const dev = device();
    const t1 = iso(60);
    const a = run(dev, 'server-time');
    a.session.emit(ev({ Kind: 'JOIN', From: 'Nyan', Target: '#lobby' }));
    a.session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: '#lobby', Message: 'old', Tags: { time: t1 } }));
    a.chat.setActive('#lobby');
    a.chat.setActive('#home');
    a.chat.detach();

    const b = run(dev, 'server-time');
    b.session.emit(ev({ Kind: 'JOIN', From: 'Nyan', Target: '#lobby' }));
    for (const [text, time] of [['old', t1], ['missed 1', iso(20)], ['missed 2', iso(10)]] as const) {
      b.session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: '#lobby', Message: text, Tags: { time } }));
    }
    expect(conv(b.chat, '#lobby')?.unread).toBe(2);
    expect(b.notified).toEqual([]);
  });
});

describe('draft/read-marker (MARKREAD)', () => {
  it('counts against the server marker sent with the JOIN, before the history', () => {
    const b = run(device(), WITH_MARKERS);
    const read = iso(30);
    joinWithHistory(b.session, '#lobby', [['alice', 'read elsewhere', iso(40)], ['bob', 'unread', iso(20)], ['bob', 'unread 2', iso(10)]], () => {
      b.session.emit(ev({ Kind: 'MARKREAD', Target: '#lobby', Message: `timestamp=${read}` }));
    });
    expect(conv(b.chat, '#lobby')?.unread).toBe(2);
  });

  it('read on another client: a later MARKREAD recounts, down to zero', () => {
    const dev = device();
    const a = run(dev, WITH_MARKERS);
    joinWithHistory(a.session, '#lobby', [['alice', 'x', iso(60)]]);
    a.chat.setActive('#lobby');
    a.chat.setActive('#home');
    a.chat.detach();
    const b = run(dev, WITH_MARKERS);
    const t2 = iso(20);
    const t3 = iso(10);
    joinWithHistory(b.session, '#lobby', [['alice', 'x', iso(60)], ['bob', 'two', t2], ['bob', 'three', t3]]);
    expect(conv(b.chat, '#lobby')?.unread).toBe(2);
    b.session.emit(ev({ Kind: 'MARKREAD', Target: '#lobby', Message: `timestamp=${t2}` }));
    expect(conv(b.chat, '#lobby')?.unread).toBe(1);
    b.session.emit(ev({ Kind: 'MARKREAD', Target: '#lobby', Message: `timestamp=${t3}` }));
    expect(conv(b.chat, '#lobby')).toMatchObject({ unread: 0, mentions: 0 });
  });

  it('a server marker replaces a marker that was only a guess, even an older one', () => {
    const b = run(device(), WITH_MARKERS);
    joinWithHistory(b.session, '#lobby', [['alice', 'a', iso(60)], ['bob', 'b', iso(20)]]);
    // Never read on this device: no count (marker guessed at attach).
    expect(conv(b.chat, '#lobby')?.unread).toBe(0);
    // The server says it was read up to an hour ago: one is unread.
    b.session.emit(ev({ Kind: 'MARKREAD', Target: '#lobby', Message: `timestamp=${iso(30)}` }));
    expect(conv(b.chat, '#lobby')?.unread).toBe(1);
  });

  it('never moves backwards, and catches a server that is behind up', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dev = device();
    const a = run(dev, WITH_MARKERS);
    const t2 = iso(10);
    joinWithHistory(a.session, '#lobby', [['alice', 'a', iso(60)], ['bob', 'b', t2]]);
    a.chat.setActive('#lobby');
    a.chat.setActive('#home');
    vi.advanceTimersByTime(1500);
    a.session.raws.length = 0;
    // An older marker from the server: ignored, and we send ours back.
    a.session.emit(ev({ Kind: 'MARKREAD', Target: '#lobby', Message: `timestamp=${iso(60)}` }));
    expect(conv(a.chat, '#lobby')?.unread).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(markreads(a.session)).toEqual([`MARKREAD #lobby timestamp=${new Date(ms(t2)).toISOString()}`]);
    expect(a.readMarkers.get('#lobby')).toBe(ms(t2));
  });

  it('sends MARKREAD when the conversation is read, debounced, only when it moves', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = run(device(), WITH_MARKERS);
    const t = iso(5);
    joinWithHistory(a.session, '#lobby', [['alice', 'a', t]]);
    a.chat.setActive('#lobby');
    // Live lines while it's open: one MARKREAD for the lot, after a second.
    const live: string[] = [];
    for (let i = 0; i < 3; i++) {
      const time = new Date(Date.now() - (3 - i) * 1000).toISOString();
      live.push(time);
      a.session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: '#lobby', Message: `l${i}`, Tags: { time } }));
    }
    expect(markreads(a.session)).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(markreads(a.session)).toEqual([`MARKREAD #lobby timestamp=${live[2]}`]);
    // Re-opening with nothing new sends nothing.
    a.chat.setActive('#home');
    a.chat.setActive('#lobby');
    vi.advanceTimersByTime(1000);
    expect(markreads(a.session)).toHaveLength(1);
    // The server echoing our own marker back changes nothing.
    a.session.emit(ev({ Kind: 'MARKREAD', Target: '#lobby', Message: `timestamp=${live[2]}` }));
    vi.advanceTimersByTime(1000);
    expect(markreads(a.session)).toHaveLength(1);
  });

  it('sends nothing to a server without the cap', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = run(device(), HISTORY);
    joinWithHistory(a.session, '#lobby', [['alice', 'a', iso(5)]]);
    a.chat.setActive('#lobby');
    a.session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: '#lobby', Message: 'live', Tags: { time: new Date().toISOString() } }));
    vi.advanceTimersByTime(5000);
    expect(markreads(a.session)).toEqual([]);
  });

  it("asks for each private conversation's marker before its backlog", () => {
    const a = run(device(), WITH_MARKERS);
    a.session.emit(ev({ Kind: 'BATCH', Args: ['+t', 'draft/chathistory-targets'] }));
    a.session.emit(ev({ Kind: 'CHATHISTORY', Args: ['TARGETS', 'alice', iso(1)], Tags: { batch: 't' } }));
    a.session.emit(ev({ Kind: 'CHATHISTORY', Args: ['TARGETS', '#lobby', iso(1)], Tags: { batch: 't' } }));
    a.session.emit(ev({ Kind: 'BATCH', Args: ['-t'] }));
    const i = a.session.raws.indexOf('MARKREAD alice');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(a.session.raws.indexOf('CHATHISTORY LATEST alice * 50')).toBeGreaterThan(i);
    expect(a.session.raws).not.toContain('MARKREAD #lobby');

    // A DM's backlog newer than the server's marker: unread, and a mention.
    a.session.emit(ev({ Kind: 'MARKREAD', Target: 'alice', Message: `timestamp=${iso(30)}` }));
    a.session.emit(ev({ Kind: 'BATCH', Args: ['+d', 'chathistory', 'alice'] }));
    a.session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: 'Nyan', Message: 'seen', Tags: { batch: 'd', time: iso(40) } }));
    a.session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: 'Nyan', Message: 'you there?', Tags: { batch: 'd', time: iso(10) } }));
    a.session.emit(ev({ Kind: 'BATCH', Args: ['-d'] }));
    expect(conv(a.chat, 'alice')).toMatchObject({ unread: 1, mentions: 1 });
  });

  it('a "timestamp=*" reply leaves the local marker, and hands it to the server', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dev = device();
    const t = iso(30);
    const a = run(dev, HISTORY);
    joinWithHistory(a.session, '#lobby', [['alice', 'a', t]]);
    a.chat.setActive('#lobby');
    a.chat.detach();
    const b = run(dev, WITH_MARKERS);
    joinWithHistory(b.session, '#lobby', [['alice', 'a', t], ['bob', 'new', iso(10)]], () => {
      b.session.emit(ev({ Kind: 'MARKREAD', Target: '#lobby', Message: 'timestamp=*' }));
    });
    expect(conv(b.chat, '#lobby')?.unread).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(markreads(b.session)).toEqual([`MARKREAD #lobby timestamp=${t}`]);
  });
});

describe('ReadMarkerStore', () => {
  it('persists per namespace and only moves forward with advance()', () => {
    const storage = memStorage();
    const backend = new LocalStorageReadMarkerBackend(storage);
    const s = new ReadMarkerStore('u::a', backend);
    expect(s.advance('#x', 100)).toBe(true);
    expect(s.advance('#x', 50)).toBe(false);
    expect(new ReadMarkerStore('u::a', backend).get('#x')).toBe(100);
    expect(new ReadMarkerStore('u::b', backend).get('#x')).toBeUndefined();
    s.set('#x', 10);
    expect(new ReadMarkerStore('u::a', backend).get('#x')).toBe(10);
    expect(storage.getItem(`${READ_MARKERS_PREFIX}u::a`)).toContain('"#x":10');
    backend.clear('u::');
    expect(new ReadMarkerStore('u::a', backend).get('#x')).toBeUndefined();
  });

  it('drops the conversations read longest ago past the cap', () => {
    const s = new ReadMarkerStore('m');
    for (let i = 0; i <= READ_MARKERS_CAP; i++) s.advance(`#c${i}`, i + 1);
    expect(s.get('#c0')).toBeUndefined();
    expect(s.get(`#c${READ_MARKERS_CAP}`)).toBe(READ_MARKERS_CAP + 1);
  });

  it('ignores corrupt storage', () => {
    const storage = memStorage();
    storage.setItem(`${READ_MARKERS_PREFIX}u::a`, '{not json');
    expect(new ReadMarkerStore('u::a', new LocalStorageReadMarkerBackend(storage)).get('#x')).toBeUndefined();
    storage.setItem(`${READ_MARKERS_PREFIX}u::a`, '{"#x":"nope","#y":5}');
    const s = new ReadMarkerStore('u::a', new LocalStorageReadMarkerBackend(storage));
    expect(s.get('#x')).toBeUndefined();
    expect(s.get('#y')).toBe(5);
  });
});
