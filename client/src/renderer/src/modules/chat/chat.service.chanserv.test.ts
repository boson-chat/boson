import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SERVICE_CHANNEL } from './services';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';

// ChatService ↔ ChanServ controller wiring: detection signals, our account,
// and background ChanServ replies kept out of the Server log.

interface FakeSession extends Pick<ServerSession,
  'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' |
  'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' |
  'onServicesFramework' | 'servicesFramework' | 'serverId'
> {
  emit(e: IrcEvent): void;
  rawLines: string[];
  sent: Array<[string, string]>;
}

function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const rawLines: string[] = [];
  const sent: Array<[string, string]> = [];
  const f: FakeSession = {
    serverId: 'srv-test',
    join: () => {}, part: () => {},
    privmsg: (t, m) => { sent.push([t, m]); },
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line) => { rawLines.push(line); },
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e) => listener?.(e),
    rawLines,
    sent,
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

describe('ChatService ChanServ wiring', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('detects Ergo from RPL_MYINFO', () => {
    const { chat, session } = buildChat();
    expect(chat.chanserv()?.getState().dialect).toBeNull();
    session.emit({ Kind: '004', From: 'irc.test', Target: 'Nyan', Message: '', Args: ['irc.test', 'ergo-2.19.1'], Raw: '' });
    expect(chat.chanserv()?.getState().dialect).toBe('ergo');
  });

  it('learns our account from 900 and forgets it on 901', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: '900', From: 'irc.test', Target: 'Nyan', Message: 'You are now logged in as nyan', Args: ['Nyan!u@h', 'nyan', 'You are now logged in as nyan'], Raw: '' });
    expect(chat.selfIdentity().account).toBe('nyan');
    session.emit({ Kind: '901', From: 'irc.test', Target: 'Nyan', Message: 'You are now logged out', Args: ['Nyan!u@h', 'You are now logged out'], Raw: '' });
    expect(chat.selfIdentity().account).toBeUndefined();
  });

  it('keeps background ChanServ lookups out of the Server log, but not other ChanServ notices', async () => {
    vi.useFakeTimers();
    const { chat, session } = buildChat();
    session.emit({ Kind: '004', From: 'irc.test', Target: 'Nyan', Message: '', Args: ['irc.test', 'ergo-2.19.1'], Raw: '' });
    chat.chanserv()!.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent).toContainEqual(['ChanServ', 'INFO #dev']);
    session.emit({ Kind: 'NOTICE', From: 'ChanServ', Target: 'Nyan', Message: 'Channel #dev is not registered', Raw: '' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(chat.chanserv()!.channel('#dev').info).toMatchObject({ registered: false });
    const log = () => chat.getState().channels.find((c) => c.name === SERVICE_CHANNEL)?.messages ?? [];
    expect(log().some((m) => m.text.includes('#dev is not registered'))).toBe(false);
    session.emit({ Kind: 'NOTICE', From: 'ChanServ', Target: 'Nyan', Message: 'Welcome to #lobby', Raw: '' });
    expect(log().some((m) => m.text.includes('Welcome to #lobby'))).toBe(true);
  });
});
