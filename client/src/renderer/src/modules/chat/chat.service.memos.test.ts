import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import { LocalStorageMemoStore, setMemoStore, getMemoStore } from '../memos';

// MemoServ output is turned into STRUCTURED Inbox entries, not raw text:
//   - the "You have N new memos." notice triggers a (non-destructive) LIST
//   - LIST rows become one deduped Inbox entry per memo
//   - the body is fetched lazily via readMemo() so memos stay unread on
//     the server until the user actually opens one
// These tests drive the flow with real Anope + Atheme reply formats
// (captured from the e2e docker stacks; see memo.parse.test.ts).

interface FakeSession extends Pick<ServerSession,
  'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' |
  'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' |
  'onServicesFramework' | 'servicesFramework' | 'serverId'
> {
  emit(e: IrcEvent): void;
  privmsgCalls: Array<{ target: string; body: string }>;
}

function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const f: FakeSession = {
    serverId: 'srv-test',
    join: () => {},
    part: () => {},
    privmsg: (target: string, body: string) => { f.privmsgCalls.push({ target, body }); },
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
    privmsgCalls: [],
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

function memoServ(session: FakeSession, message: string) {
  session.emit(ev({ Kind: 'NOTICE', From: 'MemoServ', Target: 'me', Message: message }));
}

function makeChat(session: FakeSession): ChatService {
  const chat = new ChatService(session as unknown as ServerSession, 'me', {
    history: new MemoryChatHistoryStore(),
    scope: { userId: 'u1', serverId: 'srv-test' },
  });
  chat.attach();
  return chat;
}

// Anope LIST output (two unread memos).
const ANOPE_LIST = [
  'Memos for me:',
  'Number  Sender   Date/Time',
  '* 1     alice  Jun 12 11:47:24 2026 UTC (14 seconds ago)',
  '* 2     bob    Jun 12 11:47:27 2026 UTC (11 seconds ago)',
];

describe('ChatService — MemoServ structured Inbox', () => {
  it('auto-issues a (non-destructive) LIST on the "N new memos" notice — and does NOT store the notice itself', () => {
    const session = makeFakeSession();
    makeChat(session);
    memoServ(session, 'You have 2 new memos.');
    expect(session.privmsgCalls).toContainEqual({ target: 'MemoServ', body: 'LIST' });
    // The notice is a trigger, not an inbox entry.
    expect(store.list()).toEqual([]);
  });

  it('does NOT auto-LIST a second time within the cooldown (no reconnect loop)', () => {
    const session = makeFakeSession();
    makeChat(session);
    memoServ(session, 'You have 2 new memos.');
    memoServ(session, 'You have 2 new memos.');
    const lists = session.privmsgCalls.filter((c) => c.body === 'LIST');
    expect(lists).toHaveLength(1);
  });

  it('turns Anope LIST rows into one structured (unfetched) entry per memo', () => {
    const session = makeFakeSession();
    makeChat(session);
    ANOPE_LIST.forEach((l) => memoServ(session, l));
    const memos = store.list();
    expect(memos).toHaveLength(2);
    expect(memos[0]).toMatchObject({
      kind: 'memo', sender: 'alice', memoIndex: 1, bodyFetched: false, read: false,
    });
    // The drifting "(N seconds ago)" suffix is stripped for a stable dedup key.
    expect(memos[0]!.memoDate).toBe('Jun 12 11:47:24 2026 UTC');
    expect(memos[1]).toMatchObject({ sender: 'bob', memoIndex: 2 });
    // Body not fetched yet (memo stays unread on the server).
    expect(memos[0]!.text).toBe('');
  });

  it('dedups across reconnect re-LISTs (same memos, no pile-up) and refreshes the index', () => {
    const session = makeFakeSession();
    makeChat(session);
    ANOPE_LIST.forEach((l) => memoServ(session, l));
    // Reconnect: same memos re-listed, indices shifted, relative time differs.
    [
      'Memos for me:',
      'Number  Sender   Date/Time',
      '  1     alice  Jun 12 11:47:24 2026 UTC (5 minutes ago)',
      '  2     bob    Jun 12 11:47:27 2026 UTC (5 minutes ago)',
    ].forEach((l) => memoServ(session, l));
    expect(store.list()).toHaveLength(2);
  });

  it('readMemo() issues READ <n>, and the reply body fills the entry (Anope)', () => {
    const session = makeFakeSession();
    const chat = makeChat(session);
    ANOPE_LIST.forEach((l) => memoServ(session, l));
    chat.readMemo(1);
    expect(session.privmsgCalls).toContainEqual({ target: 'MemoServ', body: 'READ 1' });
    // Anope READ reply: header, delete-hint (chrome), then the body.
    memoServ(session, 'Memo 1 from alice (Jun 12 11:47:24 2026 UTC (30 seconds ago)).');
    memoServ(session, 'To delete, type: /msg MemoServ DEL 1');
    memoServ(session, 'Are you around this week? Need to sync on the release.');
    const m = store.list().find((x) => x.memoIndex === 1)!;
    expect(m.bodyFetched).toBe(true);
    expect(m.text).toBe('Are you around this week? Need to sync on the release.');
  });

  it('handles the Atheme LIST + READ formats too', () => {
    const session = makeFakeSession();
    const chat = makeChat(session);
    // Atheme LIST (summary + blank line are chrome; rows carry [unread]).
    [
      'You have 2 memos (2 new).',
      ' ',
      '- 1 From: alice Sent: Jun 12 11:58:12 2026 +0000 [unread]',
      '- 2 From: bob Sent: Jun 12 11:58:16 2026 +0000 [unread]',
    ].forEach((l) => memoServ(session, l));
    const memos = store.list();
    expect(memos).toHaveLength(2);
    expect(memos[0]).toMatchObject({ sender: 'alice', memoIndex: 1, read: false });
    expect(memos[0]!.memoDate).toBe('Jun 12 11:58:12 2026 +0000');

    chat.readMemo(1);
    // Atheme READ reply: header, "----" separator (chrome), then body.
    memoServ(session, 'Memo 1 - Sent by alice, Jun 12 11:58:12 2026 +0000');
    memoServ(session, '------------------------------------------');
    memoServ(session, 'ping me re: the PR when you get a sec.');
    const m = store.list().find((x) => x.memoIndex === 1)!;
    expect(m.bodyFetched).toBe(true);
    expect(m.text).toBe('ping me re: the PR when you get a sec.');
  });

  it('handles MemoServ even when the NOTICE target != myNick (collision rename, no isToMe)', () => {
    // Regression (observed live, Nyan → Nyan2): requested "me" but the server
    // addresses us as "me2". A service NOTICE is ALWAYS for us, so memo
    // handling must not depend on the target matching myNick — otherwise the
    // reply is dropped and memos never list / READ never fills.
    const session = makeFakeSession();
    makeChat(session); // constructed with myNick = 'me'
    session.emit(ev({ Kind: 'NOTICE', From: 'MemoServ', Target: 'me2', Message: 'You have 1 new memo.' }));
    expect(session.privmsgCalls).toContainEqual({ target: 'MemoServ', body: 'LIST' });
  });

  it('READ reply fills the entry even when addressed to a renamed nick', () => {
    const session = makeFakeSession();
    const chat = makeChat(session); // myNick = 'me'
    ANOPE_LIST.forEach((l) => memoServ(session, l)); // these arrive to 'me'
    chat.readMemo(1);
    // The READ reply comes back addressed to the renamed nick 'me2'.
    session.emit(ev({ Kind: 'NOTICE', From: 'MemoServ', Target: 'me2', Message: 'Memo 1 from alice (Jun 12 11:47:24 2026 UTC (30 seconds ago)).' }));
    session.emit(ev({ Kind: 'NOTICE', From: 'MemoServ', Target: 'me2', Message: 'To delete, type: /msg MemoServ DEL 1' }));
    session.emit(ev({ Kind: 'NOTICE', From: 'MemoServ', Target: 'me2', Message: 'body after rename' }));
    expect(store.list().find((x) => x.memoIndex === 1)!.text).toBe('body after rename');
  });

  it('syncs myNick from RPL_WELCOME (001) so real-user DMs still mirror after a rename', () => {
    // The DM mirror legitimately needs isToMe; the welcome-numeric sync keeps
    // it working when the server assigns a different nick.
    const session = makeFakeSession();
    makeChat(session); // myNick = 'me'
    session.emit(ev({ Kind: '001', Target: 'me2', Message: 'Welcome to the network me2' }));
    session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: 'me2', Message: 'hi there' }));
    expect(store.list().some((m) => m.kind === 'dm' && m.sender === 'alice')).toBe(true);
  });

  it('mirrors a real-user DM into the Inbox (kind=dm) AND keeps it as a chat conversation', () => {
    const session = makeFakeSession();
    const chat = makeChat(session);
    session.emit(ev({ Kind: 'PRIVMSG', From: 'alice', Target: 'me', Message: 'hey bob' }));
    const memos = store.list();
    expect(memos).toHaveLength(1);
    expect(memos[0]).toMatchObject({ kind: 'dm', sender: 'alice', text: 'hey bob' });
    const dmChannel = chat.getState().channels.find((c) => c.name === 'alice');
    expect(dmChannel?.messages.some((m) => m.from === 'alice' && m.text === 'hey bob')).toBe(true);
  });

  it('does not mirror our own outgoing/echoed DM into the Inbox', () => {
    const session = makeFakeSession();
    makeChat(session);
    session.emit(ev({ Kind: 'PRIVMSG', From: 'me', Target: 'alice', Message: 'self echo' }));
    expect(store.list()).toEqual([]);
  });
});
