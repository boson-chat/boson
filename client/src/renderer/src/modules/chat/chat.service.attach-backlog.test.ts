// Backlog on attach: every registration pulls what was said while we were
// away, private conversations included (they have no JOIN to hang it on).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';

interface FakeSession {
  emit(e: IrcEvent): void;
  raws: string[];
  privmsgs: { target: string; message: string }[];
}

function makeFakeSession(): FakeSession & Record<string, unknown> {
  let listener: EventListener | null = null;
  const raws: string[] = [];
  const privmsgs: { target: string; message: string }[] = [];
  return {
    serverId: 'srv-test',
    join: () => {}, part: () => {},
    privmsg: (target: string, message: string) => { privmsgs.push({ target, message }); },
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line: string) => { raws.push(line); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e: IrcEvent) => listener?.(e),
    raws,
    privmsgs,
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
afterEach(() => { setServiceCredentialsStore(savedStore); });

function buildChat(caps: string): { chat: ChatService; session: FakeSession } {
  const session = makeFakeSession();
  const chat = new ChatService(session as unknown as ServerSession, 'Nyan', undefined, { bouncer: true });
  chat.attach();
  if (caps) session.emit({ Kind: 'CAP', From: '', Target: '', Message: caps, Args: ['ACK'], Raw: '' });
  return { chat, session };
}

const ev = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>): IrcEvent =>
  ({ From: '', Target: '', Message: '', Raw: '', ...e });
const welcome = (s: FakeSession) => s.emit(ev({ Kind: '001', From: 'bnc', Target: 'Nyan', Message: 'Welcome' }));
const selfJoin = (s: FakeSession, chan: string) => s.emit(ev({ Kind: 'JOIN', From: 'Nyan', Target: chan }));
const batchStart = (s: FakeSession, ref: string, ...params: string[]) => s.emit(ev({ Kind: 'BATCH', Args: [`+${ref}`, ...params] }));
const batchEnd = (s: FakeSession, ref: string) => s.emit(ev({ Kind: 'BATCH', Args: [`-${ref}`] }));
const listed = (s: FakeSession, ref: string, target: string) =>
  s.emit(ev({ Kind: 'CHATHISTORY', Args: ['TARGETS', target, '2026-10-11T10:00:00.000Z'], Tags: { batch: ref } }));
const said = (s: FakeSession, ref: string, from: string, to: string, text: string, time: string, msgid?: string) =>
  s.emit(ev({ Kind: 'PRIVMSG', From: from, Target: to, Message: text, Tags: { batch: ref, time, ...(msgid ? { msgid } : {}) } }));

const conv = (chat: ChatService, name: string) => chat.getState().channels.find((c) => c.name === name);
const texts = (chat: ChatService, name: string) => conv(chat, name)?.messages.map((m) => m.text) ?? [];
const latest = (s: FakeSession) => s.raws.filter((r) => r.startsWith('CHATHISTORY LATEST'));

describe('backlog on attach — chathistory (soju, ergo)', () => {
  it('asks which conversations were active, over the last 30 days', () => {
    const { session } = buildChat('batch server-time chathistory');
    const before = Date.now();
    welcome(session);
    const line = session.raws.find((r) => r.startsWith('CHATHISTORY TARGETS'));
    const m = /^CHATHISTORY TARGETS timestamp=(\S+) timestamp=(\S+) (\d+)$/.exec(line ?? '');
    expect(m).not.toBeNull();
    const from = Date.parse(m![1]!);
    const to = Date.parse(m![2]!);
    expect(before - from).toBeGreaterThanOrEqual(30 * 24 * 60 * 60_000);
    expect(before - from).toBeLessThan(31 * 24 * 60 * 60_000);
    expect(to).toBeGreaterThanOrEqual(before);
  });

  it('fetches the latest lines of each private conversation it lists, not channels or ourselves', () => {
    const { session } = buildChat('batch server-time draft/chathistory');
    welcome(session);
    batchStart(session, 't1', 'draft/chathistory-targets');
    listed(session, 't1', 'alice');
    listed(session, 't1', '#lobby');
    listed(session, 't1', 'nyan');
    listed(session, 't1', 'Bob');
    // Nothing is requested until the list is complete.
    expect(latest(session)).toEqual([]);
    batchEnd(session, 't1');
    expect(latest(session)).toEqual(['CHATHISTORY LATEST alice * 50', 'CHATHISTORY LATEST Bob * 50']);
  });

  it('accepts the ratified chathistory-targets batch name too', () => {
    const { session } = buildChat('batch server-time chathistory');
    welcome(session);
    batchStart(session, 't1', 'chathistory-targets');
    listed(session, 't1', 'alice');
    batchEnd(session, 't1');
    expect(latest(session)).toEqual(['CHATHISTORY LATEST alice * 50']);
  });

  it('lands a private backlog in its conversation, in order, quietly', () => {
    const { chat, session } = buildChat('batch server-time chathistory');
    welcome(session);
    selfJoin(session, '#lobby'); // the active conversation
    batchStart(session, 't1', 'chathistory-targets');
    listed(session, 't1', 'alice');
    batchEnd(session, 't1');

    batchStart(session, 'h1', 'chathistory', 'alice');
    said(session, 'h1', 'Nyan', 'alice', 'fine, you?', '2026-10-11T10:01:00.000Z', 'm2');
    said(session, 'h1', 'alice', 'Nyan', 'how are you', '2026-10-11T10:00:00.000Z', 'm1');
    said(session, 'h1', 'alice', 'Nyan', 'good', '2026-10-11T10:02:00.000Z', 'm3');
    batchEnd(session, 'h1');

    expect(texts(chat, 'alice')).toEqual(['how are you', 'fine, you?', 'good']);
    expect(conv(chat, 'alice')!.messages.map((m) => m.from)).toEqual(['alice', 'Nyan', 'alice']);
    expect(conv(chat, 'alice')!.unread).toBe(0);
    expect(chat.getState().activeChannel).toBe('#lobby');
  });

  it('still fetches each channel on its JOIN', () => {
    const { session } = buildChat('batch server-time chathistory');
    welcome(session);
    selfJoin(session, '#lobby');
    expect(latest(session)).toEqual(['CHATHISTORY LATEST #lobby * 50']);
  });

  it('a new attach fetches again, and lines already shown are not repeated', () => {
    const { chat, session } = buildChat('batch server-time chathistory');
    welcome(session);
    selfJoin(session, '#lobby');
    batchStart(session, 'h1', 'chathistory', '#lobby');
    said(session, 'h1', 'bob', '#lobby', 'while you were out', '2026-10-11T09:00:00.000Z', 'x1');
    batchEnd(session, 'h1');

    // Reconnected: ZNC/soju greets us again and re-sends the JOIN.
    welcome(session);
    selfJoin(session, '#lobby');
    expect(session.raws.filter((r) => r.startsWith('CHATHISTORY TARGETS'))).toHaveLength(2);
    expect(latest(session)).toEqual(['CHATHISTORY LATEST #lobby * 50', 'CHATHISTORY LATEST #lobby * 50']);

    batchStart(session, 'h2', 'chathistory', '#lobby');
    said(session, 'h2', 'bob', '#lobby', 'while you were out', '2026-10-11T09:00:00.000Z', 'x1');
    said(session, 'h2', 'bob', '#lobby', 'and again later', '2026-10-11T11:00:00.000Z', 'x2');
    batchEnd(session, 'h2');
    const t = texts(chat, '#lobby');
    expect(t.filter((x) => x === 'while you were out')).toHaveLength(1);
    expect(t).toContain('and again later');
  });

  it('a CHATHISTORY line outside a targets batch is ignored', () => {
    const { chat, session } = buildChat('batch server-time chathistory');
    welcome(session);
    session.emit(ev({ Kind: 'CHATHISTORY', Args: ['TARGETS', 'mallory', '2026-10-11T10:00:00.000Z'] }));
    expect(latest(session)).toEqual([]);
    expect(conv(chat, 'mallory')).toBeUndefined();
  });

  it('stops asking once the server rejects CHATHISTORY', () => {
    const { session } = buildChat('batch server-time chathistory');
    welcome(session);
    session.emit(ev({ Kind: '421', From: 'bnc', Target: 'Nyan', Args: ['CHATHISTORY'], Message: 'Unknown command' }));
    welcome(session);
    selfJoin(session, '#lobby');
    expect(session.raws.filter((r) => r.startsWith('CHATHISTORY'))).toHaveLength(1);
  });
});

describe('backlog on attach — ZNC playback module', () => {
  const playback = 'batch server-time znc.in/playback';

  it('replays every buffer at once, and the channel JOINs that follow ask for nothing more', () => {
    const { session } = buildChat(playback);
    welcome(session);
    selfJoin(session, '#lobby');
    selfJoin(session, '#dev');
    expect(session.privmsgs).toEqual([{ target: '*playback', message: 'PLAY * 0' }]);
    expect(session.raws.some((r) => r.startsWith('CHATHISTORY'))).toBe(false);
  });

  it('lands each buffer in its conversation, private ones included', () => {
    const { chat, session } = buildChat(playback);
    welcome(session);
    selfJoin(session, '#lobby');
    batchStart(session, 'z1', 'znc.in/playback', '#lobby');
    said(session, 'z1', 'bob', '#lobby', 'channel line', '2026-10-11T09:00:00.000Z');
    batchEnd(session, 'z1');
    batchStart(session, 'z2', 'znc.in/playback', 'alice');
    said(session, 'z2', 'alice', 'Nyan', 'are you there?', '2026-10-11T09:30:00.000Z');
    said(session, 'z2', 'Nyan', 'alice', 'from my phone', '2026-10-11T09:31:00.000Z');
    batchEnd(session, 'z2');

    expect(texts(chat, '#lobby')).toContain('channel line');
    expect(texts(chat, 'alice')).toEqual(['are you there?', 'from my phone']);
    expect(conv(chat, 'alice')!.unread).toBe(0);
  });

  it('a new attach replays again without doubling what is already shown', () => {
    const { chat, session } = buildChat(playback);
    const replay = (ref: string) => {
      batchStart(session, ref, 'znc.in/playback', 'alice');
      said(session, ref, 'alice', 'Nyan', 'are you there?', '2026-10-11T09:30:00.000Z');
      batchEnd(session, ref);
    };
    welcome(session);
    replay('z1');
    welcome(session);
    replay('z2');
    expect(session.privmsgs.filter((p) => p.message === 'PLAY * 0')).toHaveLength(2);
    expect(texts(chat, 'alice')).toEqual(['are you there?']);
  });

  it('a channel joined before any welcome is still played on its own', () => {
    const { session } = buildChat(playback);
    selfJoin(session, '#early');
    expect(session.privmsgs).toEqual([{ target: '*playback', message: 'PLAY #early 0' }]);
  });
});

describe('backlog on attach — carried-over conversations', () => {
  it('backlog merges by time with what the last connection showed', () => {
    const { chat, session } = buildChat('batch server-time');
    chat.seedConversations([{ name: '#lobby', messages: [
      { id: 'c1', kind: 'message', from: 'bob', text: 'seen at nine', timestamp: Date.parse('2026-10-11T09:00:00.000Z') },
      { id: 'c2', kind: 'message', from: 'bob', text: 'seen at eleven', timestamp: Date.parse('2026-10-11T11:00:00.000Z') },
    ] }]);
    welcome(session);
    selfJoin(session, '#lobby');
    batchStart(session, 'z1', 'znc.in/playback', '#lobby');
    said(session, 'z1', 'bob', '#lobby', 'seen at nine', '2026-10-11T09:00:00.000Z');
    said(session, 'z1', 'carol', '#lobby', 'missed at ten', '2026-10-11T10:00:00.000Z');
    said(session, 'z1', 'carol', '#lobby', 'missed at noon', '2026-10-11T12:00:00.000Z');
    batchEnd(session, 'z1');
    expect(texts(chat, '#lobby').filter((t) => t !== 'You joined #lobby'))
      .toEqual(['seen at nine', 'missed at ten', 'seen at eleven', 'missed at noon']);
  });

  it('exportConversations hands over every conversation with lines in it', () => {
    const { chat, session } = buildChat('batch server-time');
    welcome(session);
    selfJoin(session, '#lobby');
    session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: 'Nyan', Message: 'psst' }));
    const out = chat.exportConversations();
    expect(out.map((c) => c.name).sort()).toEqual(['#lobby', 'alice']);
    const next = buildChat('batch server-time').chat;
    next.seedConversations(out);
    expect(texts(next, 'alice')).toEqual(['psst']);
    expect(texts(next, '#lobby')).toEqual(['You joined #lobby']);
  });
});

describe('backlog on attach — no backlog capability', () => {
  it('asks for nothing: a plain ZNC replays its buffers by itself', () => {
    const { session } = buildChat('batch server-time');
    welcome(session);
    selfJoin(session, '#lobby');
    expect(session.raws.some((r) => r.startsWith('CHATHISTORY'))).toBe(false);
    expect(session.privmsgs).toEqual([]);
  });

  it('its own replay batch still lands, private buffers included', () => {
    const { chat, session } = buildChat('batch server-time');
    welcome(session);
    batchStart(session, 'z1', 'znc.in/playback', 'alice');
    said(session, 'z1', 'alice', 'Nyan', 'left you a note', '2026-10-11T08:00:00.000Z');
    batchEnd(session, 'z1');
    expect(texts(chat, 'alice')).toEqual(['left you a note']);
  });
});
