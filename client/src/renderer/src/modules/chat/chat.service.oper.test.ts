import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';

// Tests for ChatService own-oper tracking (ChatState.myOper). The engine
// forwards event.IsOper for numeric 381 (RPL_YOUREOPER) and a self user-mode
// grant (MODE <ournick> +o); the service latches it so the owner-only
// operator-management UI can gate on it.

interface FakeSession extends Pick<ServerSession,
  'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' |
  'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' |
  'onServicesFramework' | 'servicesFramework' | 'serverId'
> {
  emit(e: IrcEvent): void;
  rawLines: string[];
}

function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const rawLines: string[] = [];
  const f: FakeSession = {
    serverId: 'srv-test',
    join: () => {}, part: () => {},
    privmsg: () => {},
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line) => { rawLines.push(line); },
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e) => listener?.(e),
    rawLines,
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

describe('ChatService.myOper', () => {
  it('defaults to false', () => {
    const { chat } = buildChat();
    expect(chat.getState().myOper).toBe(false);
  });

  it('latches true on numeric 381 (RPL_YOUREOPER)', () => {
    const { chat, session } = buildChat();
    session.emit({
      Kind: '381', From: 'irc.boson.chat', Target: 'Nyan',
      Message: 'You are now an IRC operator', IsOper: true, Raw: '',
    });
    expect(chat.getState().myOper).toBe(true);
  });

  it('latches true on a self MODE +o (target is our nick)', () => {
    const { chat, session } = buildChat();
    session.emit({
      Kind: 'MODE', From: 'irc.boson.chat', Target: 'Nyan',
      Message: '', Args: ['+o'], IsOper: true, Raw: '',
    });
    expect(chat.getState().myOper).toBe(true);
  });

  it('does NOT latch on another user\'s oper event', () => {
    const { chat, session } = buildChat();
    // Defensive: even if IsOper somehow rode in on a MODE for a different
    // target, we must not promote ourselves.
    session.emit({
      Kind: 'MODE', From: 'irc.boson.chat', Target: 'someoneelse',
      Message: '', Args: ['+o'], IsOper: true, Raw: '',
    });
    expect(chat.getState().myOper).toBe(false);
  });

  it('stays latched once set', () => {
    const { chat, session } = buildChat();
    session.emit({ Kind: '381', From: 's', Target: 'Nyan', Message: '', IsOper: true, Raw: '' });
    // A later unrelated event must not clear it.
    session.emit({ Kind: 'NOTICE', From: 'NickServ', Target: 'Nyan', Message: 'hi', Raw: '' });
    expect(chat.getState().myOper).toBe(true);
  });
});

describe('ChatService /oper command', () => {
  it('forwards /oper <name> <password> as a raw OPER line', () => {
    const { chat, session } = buildChat();
    chat.input('/oper bosonroot s3cret');
    expect(session.rawLines).toContain('OPER bosonroot s3cret');
  });

  it('shows usage when /oper is called with no args', () => {
    const { chat, session } = buildChat();
    chat.input('/oper');
    expect(session.rawLines.some((l) => l.startsWith('OPER'))).toBe(false);
  });
});
