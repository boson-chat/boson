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

describe('ChatService — ZNC control bots', () => {
  it('routes a *status message to the service sink, not a DM tab', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'PRIVMSG', From: '*status', Target: 'Nyan', Message: 'Network libera added', Raw: '' });
    const names = chat.getState().channels.map((c) => c.name);
    // No DM conversation for the bouncer control bot.
    expect(names).not.toContain('*status');
  });
});

describe('ChatService — znc.in/playback fallback', () => {
  const enablePlayback = (s: FakeSession) =>
    s.emit({ Kind: 'CAP', From: '', Target: '', Message: 'batch server-time znc.in/playback', Args: ['ACK'], Raw: '' });

  it('drives *playback PLAY on join when chathistory is absent but playback is present', () => {
    const { session } = buildChat();
    enablePlayback(session);
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    expect(session.privmsgs).toContainEqual({ target: '*playback', message: 'PLAY #t 0' });
    expect(session.raws.some((r) => r.startsWith('CHATHISTORY'))).toBe(false);
  });

  it('routes a znc.in/playback batch as quiet backlog', () => {
    const { chat, session } = buildChat();
    enablePlayback(session);
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#a', Message: '', Raw: '' }); // active
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#b', Message: '', Raw: '' });
    session.emit({ Kind: 'BATCH', Args: ['+p', 'znc.in/playback', '#b'], From: '', Target: '', Message: '', Raw: '' });
    session.emit({
      Kind: 'PRIVMSG', From: 'bob', Target: '#b', Message: 'older',
      Tags: { batch: 'p', time: '2026-06-13T08:00:00.000Z', msgid: 'p1' }, Raw: '',
    });
    session.emit({ Kind: 'BATCH', Args: ['-p'], From: '', Target: '', Message: '', Raw: '' });
    const ch = channel(chat, '#b')!;
    expect(ch.messages.some((m) => m.text === 'older')).toBe(true);
    expect(ch.unread).toBe(0); // backlog, never unread
  });
});

describe('ChatService — 421 guard', () => {
  it('stops requesting CHATHISTORY after the server 421s it', () => {
    const { session } = buildChat();
    enableChathistory(session);
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#a', Message: '', Raw: '' });
    expect(session.raws).toContain('CHATHISTORY LATEST #a * 50');
    // Server rejects the command (advertised the cap but doesn't implement it).
    session.emit({ Kind: '421', From: 's', Target: 'Nyan', Args: ['CHATHISTORY'], Message: 'Unknown command', Raw: '' });
    session.raws.length = 0;
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#b', Message: '', Raw: '' });
    expect(session.raws.some((r) => r.startsWith('CHATHISTORY'))).toBe(false);
  });
});

describe('ChatService — server-time backlog heuristic', () => {
  it('does not mark a channel unread for old (replayed) messages', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#a', Message: '', Raw: '' }); // becomes active
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#b', Message: '', Raw: '' });
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    // Backlog replay into a non-active channel → no unread bump.
    session.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#b', Message: 'replayed', Tags: { time: old, msgid: 'b1' }, Raw: '' });
    expect(channel(chat, '#b')!.unread).toBe(0);
    expect(channel(chat, '#b')!.messages.some((m) => m.text === 'replayed')).toBe(true);
    // A live message (no/now time) into the same channel → bumps.
    session.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#b', Message: 'live', Raw: '' });
    expect(channel(chat, '#b')!.unread).toBe(1);
  });
});

describe('ChatService — server-time + msgid', () => {
  it('uses the server-time tag for the message timestamp', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    session.emit({
      Kind: 'PRIVMSG', From: 'bob', Target: '#t', Message: 'hi',
      Tags: { time: '2026-06-13T10:00:00.000Z', msgid: 'm1' }, Raw: '',
    });
    const msg = channel(chat, '#t')!.messages.find((m) => m.text === 'hi')!;
    expect(msg.timestamp).toBe(Date.parse('2026-06-13T10:00:00.000Z'));
    expect(msg.msgid).toBe('m1');
  });

  it('de-dupes a message that repeats with the same msgid', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    const dup: IrcEvent = { Kind: 'PRIVMSG', From: 'bob', Target: '#t', Message: 'once', Tags: { msgid: 'x' }, Raw: '' };
    session.emit(dup);
    session.emit(dup);
    expect(channel(chat, '#t')!.messages.filter((m) => m.text === 'once')).toHaveLength(1);
  });
});

describe('ChatService — chathistory request', () => {
  it('requests CHATHISTORY LATEST on self-join when supported', () => {
    const { session } = buildChat();
    enableChathistory(session);
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    expect(session.raws).toContain('CHATHISTORY LATEST #t * 50');
  });

  it('does NOT request chathistory when the cap is absent', () => {
    const { session } = buildChat();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    expect(session.raws.some((r) => r.startsWith('CHATHISTORY'))).toBe(false);
  });

  it('caps the request size to the CHATHISTORY ISUPPORT token', () => {
    const { session } = buildChat();
    enableChathistory(session);
    session.emit({ Kind: '005', From: 's', Target: 'Nyan', Args: ['CHATHISTORY=20'], Message: 'are supported', Raw: '' });
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    expect(session.raws).toContain('CHATHISTORY LATEST #t * 20');
  });
});

describe('ChatService — chathistory batch routing', () => {
  function withBatch(): { chat: ChatService; session: FakeSession } {
    const built = buildChat();
    enableChathistory(built.session);
    built.session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    return built;
  }

  const histMsg = (text: string, time: string, msgid: string): IrcEvent => ({
    Kind: 'PRIVMSG', From: 'bob', Target: '#t', Message: text,
    Tags: { batch: 'abc', time, msgid }, Raw: '',
  });

  it('prepends batched history in time order without bumping unread', () => {
    const { chat, session } = withBatch();
    session.emit({ Kind: 'BATCH', Args: ['+abc', 'chathistory', '#t'], From: '', Target: '', Message: '', Raw: '' });
    // Emitted out of order; should sort by server-time.
    session.emit(histMsg('second', '2026-06-13T10:05:00.000Z', 'h2'));
    session.emit(histMsg('first', '2026-06-13T10:00:00.000Z', 'h1'));
    session.emit({ Kind: 'BATCH', Args: ['-abc'], From: '', Target: '', Message: '', Raw: '' });

    const ch = channel(chat, '#t')!;
    const texts = ch.messages.map((m) => m.text);
    expect(texts.indexOf('first')).toBeLessThan(texts.indexOf('second'));
    // History is older than the "You joined" line → sits above it.
    expect(texts.indexOf('first')).toBeLessThan(texts.indexOf('You joined #t'));
    expect(ch.unread).toBe(0); // backlog never marks unread
  });

  it('does not double-insert a backlog message already present live (msgid)', () => {
    const { chat, session } = withBatch();
    session.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#t', Message: 'live', Tags: { msgid: 'dup' }, Raw: '' });
    session.emit({ Kind: 'BATCH', Args: ['+abc', 'chathistory', '#t'], From: '', Target: '', Message: '', Raw: '' });
    session.emit({ ...histMsg('live', '2026-06-13T09:00:00.000Z', 'dup') });
    session.emit({ Kind: 'BATCH', Args: ['-abc'], From: '', Target: '', Message: '', Raw: '' });
    expect(channel(chat, '#t')!.messages.filter((m) => m.msgid === 'dup')).toHaveLength(1);
  });

  it('loadOlderHistory sends CHATHISTORY BEFORE with the oldest message as pivot', () => {
    // Limit 2 + a full page (2 messages) → not exhausted, so load-older runs.
    const built = buildChat();
    enableChathistory(built.session);
    built.session.emit({ Kind: '005', From: 's', Target: 'Nyan', Args: ['CHATHISTORY=2'], Message: 'ok', Raw: '' });
    built.session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    built.session.emit({ Kind: 'BATCH', Args: ['+abc', 'chathistory', '#t'], From: '', Target: '', Message: '', Raw: '' });
    built.session.emit(histMsg('first', '2026-06-13T10:00:00.000Z', 'h1'));
    built.session.emit(histMsg('second', '2026-06-13T10:05:00.000Z', 'h2'));
    built.session.emit({ Kind: 'BATCH', Args: ['-abc'], From: '', Target: '', Message: '', Raw: '' });
    expect(channel(built.chat, '#t')!.history?.exhausted).toBe(false);

    built.session.raws.length = 0; // ignore the LATEST request
    built.chat.loadOlderHistory('#t');
    expect(built.session.raws).toContain('CHATHISTORY BEFORE #t timestamp=2026-06-13T10:00:00.000Z 2');
    expect(channel(built.chat, '#t')!.history?.loading).toBe(true);
  });
});
