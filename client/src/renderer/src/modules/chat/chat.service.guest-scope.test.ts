import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';
import { LocalStorageMemoStore, setMemoStore, getMemoStore } from '../memos';

// Guests connect without chat-history persistence (no userId), but their
// connection still has a stable server id. NickServ status, auto-identify and
// MemoServ → Inbox are keyed by that id, so they must work without
// persistence when the bloc passes deps.server (regression: every NickServ
// reply and memo was dropped for guests, leaving the Identity badge stuck on
// "Registering…" / "Not connected yet").

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

interface FakeSession {
  emit(e: IrcEvent): void;
  privmsgCalls: Array<{ target: string; body: string }>;
  identifyCalls: string[];
}

function makeChat(opts: { depsServer?: boolean } = {}): { chat: ChatService; session: FakeSession } {
  let listener: EventListener | null = null;
  const f = {
    serverId: 'srv-guest',
    join: () => {}, part: () => {}, names: () => {}, tagmsg: () => {}, list: () => {},
    away: () => {}, nick: () => {}, raw: () => {},
    privmsg: (target: string, body: string) => { f.privmsgCalls.push({ target, body }); },
    nickservIdentify: (pw: string) => { f.identifyCalls.push(pw); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e: IrcEvent) => listener?.(e),
    privmsgCalls: [] as Array<{ target: string; body: string }>,
    identifyCalls: [] as string[],
  };
  const chat = new ChatService(f as unknown as ServerSession, 'me', undefined, opts.depsServer === false ? {} : {
    server: { serverId: 'srv-guest', serverName: 'Guest Net' },
  });
  chat.attach();
  return { chat, session: f };
}

const notice = (From: string, Message: string): IrcEvent =>
  ({ Kind: 'NOTICE', From, Target: 'me', Message, Raw: '' });

let savedCreds: ReturnType<typeof getServiceCredentialsStore>;
let savedMemos: ReturnType<typeof getMemoStore>;
let memos: LocalStorageMemoStore;

beforeEach(() => {
  savedCreds = getServiceCredentialsStore();
  savedMemos = getMemoStore();
  setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
  memos = new LocalStorageMemoStore('', memStorage());
  setMemoStore(memos);
});

afterEach(() => {
  setServiceCredentialsStore(savedCreds);
  setMemoStore(savedMemos);
});

describe('ChatService without persistence (guest) but with deps.server', () => {
  it('NickServ replies update the account status for the server', () => {
    const { session } = makeChat();
    session.emit(notice('NickServ', 'Account created, pending verification; verification code has been sent to a@b.test'));
    expect(getServiceCredentialsStore().get('srv-guest')?.status).toBe('pending-confirmation');
    session.emit(notice('NickServ', 'Authentication failed: Invalid account credentials'));
    expect(getServiceCredentialsStore().get('srv-guest')?.status).toBe('identify-failed');
  });

  it('triggerAutoIdentify uses the saved password for the server', () => {
    const { chat, session } = makeChat();
    getServiceCredentialsStore().set('srv-guest', { nickservPassword: 'hunter2' });
    chat.triggerAutoIdentify();
    expect(session.identifyCalls).toEqual(['hunter2']);
  });

  it('MemoServ LIST rows land in the Inbox attributed to the server', () => {
    const { session } = makeChat();
    session.emit(notice('MemoServ', 'You have 1 new memo.'));
    expect(session.privmsgCalls).toContainEqual({ target: 'MemoServ', body: 'LIST' });
    session.emit(notice('MemoServ', '* 1     alice  Jun 12 11:47:24 2026 UTC (14 seconds ago)'));
    expect(memos.list()).toEqual([
      expect.objectContaining({ kind: 'memo', sender: 'alice', serverId: 'srv-guest', serverName: 'Guest Net', memoIndex: 1 }),
    ]);
  });
});

describe('ChatService without persistence or deps.server', () => {
  it('falls back to the session\'s serverId', () => {
    const { session } = makeChat({ depsServer: false });
    session.emit(notice('NickServ', 'Authentication failed: Invalid account credentials'));
    expect(getServiceCredentialsStore().get('srv-guest')?.status).toBe('identify-failed');
  });
});

// A NickServ password that lands in the store after connect (the backend sync
// on a fresh device races the session-restore connect) must still identify.
describe('ChatService — NickServ password arriving after connect', () => {
  const welcome: IrcEvent = { Kind: '001', From: 'ergo.test', Target: 'me', Message: 'Welcome', Raw: '' };

  it('identifies right away when it arrives after the welcome', () => {
    const { session } = makeChat();
    session.emit(welcome);
    expect(session.identifyCalls).toEqual([]);
    getServiceCredentialsStore().set('srv-guest', { nickservPassword: 'synced-pw', accountName: 'me' });
    expect(session.identifyCalls).toEqual(['synced-pw']);
    // Later writes (status updates, same password) don't re-identify.
    getServiceCredentialsStore().set('srv-guest', { nickservPassword: 'synced-pw', accountName: 'me', status: 'identified' });
    expect(session.identifyCalls).toEqual(['synced-pw']);
  });

  it('identifies on the welcome when it arrived between connect and welcome', () => {
    const { session } = makeChat();
    getServiceCredentialsStore().set('srv-guest', { nickservPassword: 'synced-pw' });
    expect(session.identifyCalls).toEqual([]);
    session.emit(welcome);
    expect(session.identifyCalls).toEqual(['synced-pw']);
  });

  it('leaves it to the engine when the password was there at connect', () => {
    getServiceCredentialsStore().set('srv-guest', { nickservPassword: 'saved-pw' });
    const { session } = makeChat();
    session.emit(welcome);
    expect(session.identifyCalls).toEqual([]);
  });

  it('does not identify for passwords written by an account flow (status set)', () => {
    const { session } = makeChat();
    session.emit(welcome);
    getServiceCredentialsStore().set('srv-guest', { nickservPassword: 'generated', status: 'pending-confirmation' });
    expect(session.identifyCalls).toEqual([]);
  });
});
