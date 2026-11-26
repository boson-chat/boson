import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';

interface FakeSession extends Pick<ServerSession,
  'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' |
  'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' |
  'onServicesFramework' | 'servicesFramework' | 'serverId'
> {
  emit(e: IrcEvent): void;
  raws: string[];
  privmsgs: { target: string; message: string }[];
}

function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const raws: string[] = [];
  const privmsgs: { target: string; message: string }[] = [];
  const f: FakeSession = {
    serverId: 'srv-test',
    join: () => {}, part: () => {},
    privmsg: (target, message) => { privmsgs.push({ target, message }); },
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line) => { raws.push(line); },
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e) => listener?.(e),
    raws,
    privmsgs,
  };
  return f;
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

function buildChat(): { chat: ChatService; session: FakeSession } {
  const session = makeFakeSession();
  const chat = new ChatService(
    session as unknown as ServerSession,
    'Nyan',
    { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
  );
  chat.attach();
  return { chat, session };
}

const enableChathistory = (s: FakeSession) =>
  s.emit({ Kind: 'CAP', From: '', Target: '', Message: 'chathistory', Args: ['ACK'], Raw: '' });

const channel = (chat: ChatService, name: string) =>
  chat.getState().channels.find((c) => c.name === name);


const ev = (e: Partial<IrcEvent> & { Kind: string }): IrcEvent => ({ From: '', Target: '', Message: '', Raw: '', ...e });

// A channel we're in, with alice and bob as members and a topic.
function joined(): { chat: ChatService; session: FakeSession } {
  const { chat, session } = buildChat();
  enableChathistory(session);
  session.emit(ev({ Kind: 'JOIN', From: 'Nyan', Target: '#t' }));
  session.emit(ev({ Kind: '353', Target: '#t', Message: 'Nyan alice bob' }));
  session.emit(ev({ Kind: '366', Target: '#t' }));
  session.emit(ev({ Kind: '332', Target: '#t', Message: 'live topic' }));
  return { chat, session };
}

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

// One chathistory batch for #t.
function replay(session: FakeSession, ref: string, events: IrcEvent[]): void {
  session.emit(ev({ Kind: 'BATCH', Args: [`+${ref}`, 'chathistory', '#t'] }));
  for (const e of events) session.emit({ ...e, Tags: { batch: ref, ...e.Tags } });
  session.emit(ev({ Kind: 'BATCH', Args: [`-${ref}`] }));
}

describe('ChatService — event-playback history', () => {
  it('renders replayed joins/parts/quits/kicks/topic/mode as rows at their server time', () => {
    const { chat, session } = joined();
    replay(session, 'h1', [
      ev({ Kind: 'JOIN', From: 'carol', Target: '#t', User: 'c', Host: 'h', Tags: { msgid: 'j1', time: at(1) } }),
      ev({ Kind: 'PRIVMSG', From: 'carol', Target: '#t', Message: 'hi all', Tags: { msgid: 'p1', time: at(2) } }),
      ev({ Kind: 'PART', From: 'carol', Target: '#t', Message: 'bye', Tags: { msgid: 'l1', time: at(3) } }),
      ev({ Kind: 'QUIT', From: 'dave', Message: 'Quit: shutting down', Tags: { msgid: 'q1', time: at(4) } }),
      ev({ Kind: 'KICK', From: 'alice', Target: '#t', Args: ['erin'], Message: 'spam', Tags: { msgid: 'k1', time: at(5) } }),
      ev({ Kind: 'TOPIC', From: 'alice', Target: '#t', Message: 'old topic', Tags: { msgid: 't1', time: at(6) } }),
      ev({ Kind: 'MODE', From: 'alice', Target: '#t', Args: ['+v', 'bob'], Tags: { msgid: 'm1', time: at(7) } }),
      ev({ Kind: 'NICK', From: 'bob', Message: 'bobby', Tags: { msgid: 'n1', time: at(8) } }),
    ]);
    const rows = channel(chat, '#t')!.messages.filter((m) => m.msgid);
    expect(rows.map((m) => [m.kind, m.text, m.serverTime])).toEqual([
      ['join', 'carol joined', T0 + 1000],
      ['message', 'hi all', T0 + 2000],
      ['part', 'carol left', T0 + 3000],
      ['quit', 'dave quit (Quit: shutting down)', T0 + 4000],
      ['kick', 'alice kicked erin (spam)', T0 + 5000],
      ['system', 'alice changed the topic to: old topic', T0 + 6000],
      ['system', 'alice sets mode +v bob', T0 + 7000],
    ]);
    expect(channel(chat, '#t')!.unread).toBe(0);
  });

  it("doesn't touch live state: members, topic, our nick, our membership", () => {
    const { chat, session } = joined();
    const before = channel(chat, '#t')!;
    const members = before.members.map((m) => [m.nick, m.prefix]);
    replay(session, 'h2', [
      ev({ Kind: 'JOIN', From: 'carol', Target: '#t', Tags: { time: at(1) } }),
      ev({ Kind: 'QUIT', From: 'alice', Message: 'gone', Tags: { time: at(2) } }),
      ev({ Kind: 'PART', From: 'bob', Target: '#t', Tags: { time: at(3) } }),
      ev({ Kind: 'KICK', From: 'alice', Target: '#t', Args: ['Nyan'], Tags: { time: at(4) } }),
      ev({ Kind: 'PART', From: 'Nyan', Target: '#t', Tags: { time: at(5) } }),
      ev({ Kind: 'NICK', From: 'Nyan', Message: 'Other', Tags: { time: at(6) } }),
      ev({ Kind: 'TOPIC', From: 'alice', Target: '#t', Message: 'old topic', Tags: { time: at(7) } }),
      ev({ Kind: 'MODE', From: 'alice', Target: '#t', Args: ['+o', 'bob'], Tags: { time: at(8) } }),
    ]);
    const ch = channel(chat, '#t')!;
    expect(ch).toBeTruthy();
    expect(ch.members.map((m) => [m.nick, m.prefix])).toEqual(members);
    expect(ch.topic).toBe('live topic');
    expect(chat.getState().myNick).toBe('Nyan');
    // Our own replayed part doesn't show as someone else's row.
    expect(ch.messages.some((m) => m.from === 'Nyan' && m.kind === 'part')).toBe(false);
  });

  it('dedupes replayed events against live rows: by msgid, else kind + nick + time', () => {
    const { chat, session } = joined();
    const now = Date.now();
    // Live events: one with a msgid (Ergo), one without.
    session.emit(ev({ Kind: 'JOIN', From: 'carol', Target: '#t', Tags: { msgid: 'live-j', time: new Date(now).toISOString() } }));
    session.emit(ev({ Kind: 'QUIT', From: 'alice', Message: 'bye' }));
    replay(session, 'h3', [
      ev({ Kind: 'JOIN', From: 'carol', Target: '#t', Tags: { msgid: 'live-j', time: new Date(now).toISOString() } }),
      ev({ Kind: 'QUIT', From: 'alice', Message: 'bye', Tags: { msgid: 'hq', time: new Date(now + 1500).toISOString() } }),
      // Long before: a different occurrence, kept.
      ev({ Kind: 'QUIT', From: 'alice', Message: 'bye', Tags: { msgid: 'hq0', time: new Date(now - 3600_000).toISOString() } }),
    ]);
    const ch = channel(chat, '#t')!;
    expect(ch.messages.filter((m) => m.kind === 'join' && m.from === 'carol')).toHaveLength(1);
    expect(ch.messages.filter((m) => m.kind === 'quit' && m.from === 'alice')).toHaveLength(2);
    // The same history again (another attach) adds nothing.
    const n = ch.messages.length;
    replay(session, 'h4', [
      ev({ Kind: 'QUIT', From: 'alice', Message: 'bye', Tags: { msgid: 'hq0', time: new Date(now - 3600_000).toISOString() } }),
    ]);
    expect(channel(chat, '#t')!.messages.length).toBe(n);
  });

  it("drops HistServ's replay lines from channel backlog, but not other HistServ lines", () => {
    const { chat, session } = joined();
    replay(session, 'h5', [
      ev({ Kind: 'PRIVMSG', From: 'HistServ', Target: '#t', Message: 'TheLion-windows [account: TheLion-windows] joined the channel', Tags: { msgid: '_a', time: at(1) } }),
      ev({ Kind: 'PRIVMSG', From: 'HistServ', Target: '#t', Message: 'bob quit (Quit: shutting down)', Tags: { msgid: '_b', time: at(2) } }),
      ev({ Kind: 'PRIVMSG', From: 'HistServ', Target: '#t', Message: 'bob sent a TAGMSG', Tags: { msgid: '_c', time: at(3) } }),
      ev({ Kind: 'PRIVMSG', From: 'HistServ', Target: '#t', Message: 'not a replay line', Tags: { msgid: '_d', time: at(4) } }),
    ]);
    const hs = channel(chat, '#t')!.messages.filter((m) => m.from === 'HistServ');
    expect(hs.map((m) => m.text)).toEqual(['not a replay line']);
  });

  it('keeps a HistServ query alone', () => {
    const { chat, session } = buildChat();
    enableChathistory(session);
    session.emit(ev({ Kind: 'BATCH', Args: ['+q', 'chathistory', 'HistServ'] }));
    session.emit(ev({ Kind: 'PRIVMSG', From: 'HistServ', Target: 'Nyan', Message: 'bob joined the channel', Tags: { batch: 'q', time: at(1) } }));
    session.emit(ev({ Kind: 'BATCH', Args: ['-q'] }));
    expect(channel(chat, 'HistServ')?.messages.map((m) => m.text)).toEqual(['bob joined the channel']);
  });

  it('replayed TAGMSGs (typing) make no row and no typing state', () => {
    const { chat, session } = joined();
    const n = channel(chat, '#t')!.messages.length;
    replay(session, 'h6', [
      ev({ Kind: 'TAGMSG', From: 'bob', Target: '#t', Tags: { '+typing': 'active', time: at(1) } }),
    ]);
    const ch = channel(chat, '#t')!;
    expect(ch.messages.length).toBe(n);
    expect(ch.typing).not.toContain('bob');
  });

  it('a batch nested in a history batch is history too', () => {
    const { chat, session } = joined();
    const members = channel(chat, '#t')!.members.length;
    session.emit(ev({ Kind: 'BATCH', Args: ['+o', 'chathistory', '#t'] }));
    session.emit(ev({ Kind: 'BATCH', Args: ['+i', 'other'], Tags: { batch: 'o' } }));
    session.emit(ev({ Kind: 'JOIN', From: 'zed', Target: '#t', Tags: { batch: 'i', time: at(1) } }));
    session.emit(ev({ Kind: 'BATCH', Args: ['-i'] }));
    session.emit(ev({ Kind: 'BATCH', Args: ['-o'] }));
    const ch = channel(chat, '#t')!;
    expect(ch.members.length).toBe(members);
    expect(ch.messages.filter((m) => m.from === 'zed').map((m) => m.kind)).toEqual(['join']);
  });

  it('a page full of events is not the end of history', () => {
    const { chat, session } = joined();
    const evs: IrcEvent[] = [];
    for (let i = 0; i < 50; i++) evs.push(ev({ Kind: 'NICK', From: `n${i}`, Message: `m${i}`, Tags: { time: at(i) } }));
    replay(session, 'h7', evs);
    expect(channel(chat, '#t')!.history?.exhausted).toBe(false);
  });
});
