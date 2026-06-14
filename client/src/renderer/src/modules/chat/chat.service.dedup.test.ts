import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { ChatMessage } from './chat.types';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';

// Covers two backend-agnostic concerns that protect the chat log regardless of
// which backlog mechanism (chathistory / playback) a server offers:
//   1. duplicate suppression — bouncer reconnects replay the same buffer, and
//      without msgid we must dedupe by content to avoid stacking dups (which
//      previously ballooned the heap to a 4 GB OOM); and
//   2. the "via bouncer" server-info badge (config flag + ZNC runtime detect).

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
  } as Storage;
}

let savedStore: ReturnType<typeof getServiceCredentialsStore>;
beforeEach(() => {
  savedStore = getServiceCredentialsStore();
  setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
});
afterEach(() => { setServiceCredentialsStore(savedStore); });

function buildChat(deps?: { bouncer?: boolean }): { chat: ChatService; session: FakeSession } {
  const session = makeFakeSession();
  const chat = new ChatService(
    session as unknown as ServerSession,
    'Nyan',
    { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    deps,
  );
  chat.attach();
  return { chat, session };
}

const channel = (chat: ChatService, name: string) =>
  chat.getState().channels.find((c) => c.name === name);

describe('ChatService — duplicate suppression (OOM guard)', () => {
  it('collapses a message replayed with identical server-time (reconnect replay)', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    const ev: IrcEvent = {
      Kind: 'PRIVMSG', From: 'jrmu', Target: '#t', Message: 'are you around?',
      Tags: { time: '2026-06-13T15:00:00.000Z' }, Raw: '',
    };
    session.emit(ev); session.emit(ev); session.emit(ev); // three buffer replays
    expect(channel(chat, '#t')!.messages.filter((m) => m.text === 'are you around?')).toHaveLength(1);
  });

  it('keeps genuine repeats that carry distinct timestamps', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    session.emit({ Kind: 'PRIVMSG', From: 'jrmu', Target: '#t', Message: 'ok', Tags: { time: '2026-06-13T15:00:00.000Z' }, Raw: '' });
    session.emit({ Kind: 'PRIVMSG', From: 'jrmu', Target: '#t', Message: 'ok', Tags: { time: '2026-06-13T15:00:05.000Z' }, Raw: '' });
    expect(channel(chat, '#t')!.messages.filter((m) => m.text === 'ok')).toHaveLength(2);
  });

  it('caps in-memory messages per channel, evicting the oldest', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    for (let i = 0; i < 1600; i++) {
      session.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#t', Message: `m${i}`, Tags: { msgid: `id${i}` }, Raw: '' });
    }
    const ch = channel(chat, '#t')!;
    expect(ch.messages.length).toBeLessThanOrEqual(1500);
    expect(ch.messages.some((m) => m.text === 'm1599')).toBe(true); // newest kept
    expect(ch.messages.some((m) => m.text === 'm0')).toBe(false); // oldest evicted
  });
});

describe('ChatService — "via bouncer" badge', () => {
  it('flags bouncer from the per-server config flag', () => {
    const { chat } = buildChat({ bouncer: true });
    expect(chat.getState().serverInfo.bouncer).toBe(true);
  });

  it('detects ZNC from a *status control-bot sender', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'NOTICE', From: '*status', Target: 'Nyan', Message: 'You have 3 networks', Raw: '' });
    expect(chat.getState().serverInfo.bouncer).toBe(true);
  });

  it('detects ZNC from a znc.in/* cap advertised in CAP LS', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: 'CAP', From: 'irc.znc.in', Target: '', Message: 'batch znc.in/server-time-iso', Args: ['LS'], Raw: '' });
    expect(chat.getState().serverInfo.bouncer).toBe(true);
  });

  it('does NOT persist or hydrate messages on a bouncer connection (the bouncer is the archive)', async () => {
    const appended: string[] = [];
    const loads: string[] = [];
    const store = {
      load: (scope: { channel: string }) => { loads.push(scope.channel); return Promise.resolve([]); },
      append: (scope: { channel: string }, m: ChatMessage) => { appended.push(`${scope.channel}:${m.text}`); return Promise.resolve(); },
      clear: () => Promise.resolve(),
    };
    const session = makeFakeSession();
    const chat = new ChatService(
      session as unknown as ServerSession,
      'Nyan',
      { history: store as never, scope: { userId: 'u1', serverId: 'srv-test' } },
      { bouncer: true },
    );
    chat.attach();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    session.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#t', Message: 'hi', Raw: '' });
    await Promise.resolve();
    expect(appended).toHaveLength(0); // nothing written
    expect(loads).toHaveLength(0); // nothing hydrated
    // The message still shows in-memory (the bouncer's replay is the source).
    expect(channel(chat, '#t')!.messages.some((m) => m.text === 'hi')).toBe(true);
  });

  it('does NOT enable scroll-back from the bouncer flag alone (needs a real backlog cap)', () => {
    const { chat, session } = buildChat({ bouncer: true });
    // No chathistory / playback cap negotiated.
    expect(chat.getState().serverInfo.scrollbackAvailable).toBeFalsy();
    session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
    chat.loadOlderHistory('#t');
    // Neither CHATHISTORY nor *playback nor the dropped *backlog is issued.
    expect(session.raws.some((r) => r.startsWith('CHATHISTORY'))).toBe(false);
    expect(session.privmsgs.some((p) => p.target === '*playback' || p.target === '*backlog')).toBe(false);
  });
});
