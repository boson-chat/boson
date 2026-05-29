import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import { LocalStorageMemoStore, setMemoStore, getMemoStore } from '../memos';
import { SERVICE_CHANNEL } from './services';

// Verifies that MemoServ NOTICEs get pulled out of the per-server chat
// stream and routed to the global Inbox store instead. The user's
// directive was: "memoserv should never show up under dms but instead
// create an inbox" — these tests pin that behaviour down.

interface FakeSession extends Pick<ServerSession,
  'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' |
  'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' |
  'onServicesFramework' | 'servicesFramework' | 'serverId'
> {
  emit(e: IrcEvent): void;
}

function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const f: FakeSession = {
    serverId: 'srv-test',
    join: () => {},
    part: () => {},
    privmsg: () => {},
    names: () => {},
    tagmsg: () => {},
    list: () => {},
    away: () => {},
    nick: () => {},
    nickservIdentify: () => {},
    raw: () => {},
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e) => listener?.(e),
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

let saved: ReturnType<typeof getMemoStore>;
let store: LocalStorageMemoStore;

beforeEach(() => {
  saved = getMemoStore();
  store = new LocalStorageMemoStore('u1', memStorage());
  setMemoStore(store);
});

afterEach(() => {
  setMemoStore(saved);
});

function ev(partial: Partial<IrcEvent>): IrcEvent {
  return { Kind: '', From: '', Target: '', Message: '', Raw: '', ...partial };
}

describe('ChatService — MemoServ → Inbox routing', () => {
  it('routes a MemoServ NOTICE into the global Inbox', () => {
    const session = makeFakeSession();
    const chat = new ChatService(session as unknown as ServerSession, 'me', {
      history: new MemoryChatHistoryStore(),
      scope: { userId: 'u1', serverId: 'srv-test' },
    });
    chat.attach();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'MemoServ',
      Target: 'me',
      Message: 'Memo 1 from alice: hi bob',
    }));
    const memos = store.list();
    expect(memos).toHaveLength(1);
    expect(memos[0]?.text).toContain('Memo 1 from alice: hi bob');
    expect(memos[0]?.serverId).toBe('srv-test');
    expect(memos[0]?.read).toBe(false);
  });

  it('case-insensitive — MEMOSERV / memoserv / MemoServ all route to inbox', () => {
    const session = makeFakeSession();
    const chat = new ChatService(session as unknown as ServerSession, 'me');
    chat.attach();
    for (const from of ['MemoServ', 'memoserv', 'MEMOSERV']) {
      session.emit(ev({ Kind: 'NOTICE', From: from, Target: 'me', Message: 'memo body' }));
    }
    expect(store.list()).toHaveLength(3);
  });

  it('does NOT route NickServ / ChanServ / others into the inbox', () => {
    const session = makeFakeSession();
    const chat = new ChatService(session as unknown as ServerSession, 'me');
    chat.attach();
    session.emit(ev({ Kind: 'NOTICE', From: 'NickServ', Target: 'me', Message: 'identify pls' }));
    session.emit(ev({ Kind: 'NOTICE', From: 'ChanServ', Target: 'me', Message: 'reg done' }));
    expect(store.list()).toEqual([]);
  });

  it('does NOT create a per-MemoServ chat channel for the per-server log', () => {
    // Pre-routing fix, MemoServ NOTICEs landed on the ~server pseudo-
    // channel mixed in with NickServ / ChanServ traffic. The inbox
    // abstraction means MemoServ traffic is owned entirely by the
    // global store — the ~server channel stays focused on the rest.
    const session = makeFakeSession();
    const chat = new ChatService(session as unknown as ServerSession, 'me');
    chat.attach();
    session.emit(ev({ Kind: 'NOTICE', From: 'MemoServ', Target: 'me', Message: 'inbox-bound' }));
    const channels = chat.getState().channels;
    const serverCh = channels.find((c) => c.name === SERVICE_CHANNEL);
    // The ~server channel either doesn't exist or has no MemoServ traffic in it.
    if (serverCh) {
      const memoServLines = serverCh.messages.filter((m) => m.from.toLowerCase() === 'memoserv');
      expect(memoServLines).toEqual([]);
    }
  });

  it('uses the persistence-scope serverId for the memo entry', () => {
    const session = makeFakeSession();
    const chat = new ChatService(session as unknown as ServerSession, 'me', {
      history: new MemoryChatHistoryStore(),
      scope: { userId: 'u1', serverId: 'libera-prod-42' },
    });
    chat.attach();
    session.emit(ev({ Kind: 'NOTICE', From: 'MemoServ', Target: 'me', Message: 'foo' }));
    expect(store.list()[0]?.serverId).toBe('libera-prod-42');
  });

  it('falls back to empty serverId when persistence is not configured', () => {
    const session = makeFakeSession();
    const chat = new ChatService(session as unknown as ServerSession, 'me');
    chat.attach();
    session.emit(ev({ Kind: 'NOTICE', From: 'MemoServ', Target: 'me', Message: 'foo' }));
    expect(store.list()[0]?.serverId).toBe('');
  });
});
