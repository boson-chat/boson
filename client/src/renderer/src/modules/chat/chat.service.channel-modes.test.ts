import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';

// Channel mode / ban-list state tracking: applyChannelMode (flags + key/limit +
// live bans), RPL_CHANNELMODEIS (324), RPL_BANLIST (367) / RPL_ENDOFBANLIST
// (368) accumulation, and the ISUPPORT PREFIX=/CHANMODES= parse. The engine's
// generic numeric passthrough does NOT set Target, so 324/367/368 carry the
// channel in Args[0].

interface FakeSession extends Pick<ServerSession,
  'join'|'part'|'privmsg'|'names'|'tagmsg'|'list'|'away'|'nick'|
  'nickservIdentify'|'raw'|'onEvent'|'onChannelDirectory'|'onServicesFramework'|'servicesFramework'|'serverId'> {
  emit(e: IrcEvent): void;
  raws: string[];
}
function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const raws: string[] = [];
  const f: FakeSession = {
    serverId: 'srv', join: () => {}, part: () => {}, privmsg: () => {},
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line) => { raws.push(line); },
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {}, onServicesFramework: () => () => {},
    servicesFramework: () => null, emit: (e) => listener?.(e), raws,
  };
  return f;
}
function memStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); }, clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null, get length() { return m.size; } } as Storage;
}
let saved: ReturnType<typeof getServiceCredentialsStore>;
beforeEach(() => { saved = getServiceCredentialsStore(); setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage())); });
afterEach(() => { setServiceCredentialsStore(saved); });

function build(): { chat: ChatService; session: FakeSession } {
  const session = makeFakeSession();
  const chat = new ChatService(session as unknown as ServerSession, 'Nyan',
    { history: new MemoryChatHistoryStore(), scope: { userId: 'u', serverId: 'srv' } });
  chat.attach();
  session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' });
  return { chat, session };
}
const chan = (chat: ChatService, name = '#t') => chat.getState().channels.find((c) => c.name === name)!;
const mode = (s: FakeSession, args: string[]) =>
  s.emit({ Kind: 'MODE', From: 'op', Target: '#t', Args: args, Message: '', Raw: '' });

describe('applyChannelMode — channel modes', () => {
  it('tracks boolean flags (add + remove, sorted)', () => {
    const { chat, session } = build();
    mode(session, ['+mnt']);
    expect(chan(chat).modes?.flags).toEqual(['m', 'n', 't']);
    mode(session, ['-m']);
    expect(chan(chat).modes?.flags).toEqual(['n', 't']);
  });

  it('tracks key (+k/-k) and limit (+l/-l)', () => {
    const { chat, session } = build();
    mode(session, ['+k', 'secret']);
    expect(chan(chat).modes?.key).toBe('secret');
    mode(session, ['+l', '50']);
    expect(chan(chat).modes?.limit).toBe(50);
    mode(session, ['-k', 'secret']);
    expect(chan(chat).modes?.key).toBeUndefined();
    mode(session, ['-l']);
    expect(chan(chat).modes?.limit).toBeUndefined();
  });

  it('parses a mixed modestring with positional params', () => {
    const { chat, session } = build();
    mode(session, ['+mk-l', 'thekey']); // +m, +k thekey, -l (no arg)
    const m = chan(chat).modes!;
    expect(m.flags).toContain('m');
    expect(m.key).toBe('thekey');
    expect(m.limit).toBeUndefined();
  });

  it('still updates member prefixes (regression)', () => {
    const { chat, session } = build();
    session.emit({ Kind: '353', From: 's', Target: '#t', Args: ['#t'], Message: 'bob', Raw: '' });
    session.emit({ Kind: '366', From: 's', Target: '#t', Args: ['#t'], Message: '', Raw: '' });
    mode(session, ['+o', 'bob']);
    expect(chan(chat).members.find((m) => m.nick === 'bob')?.prefix).toBe('@');
    mode(session, ['-o', 'bob']);
    expect(chan(chat).members.find((m) => m.nick === 'bob')?.prefix).toBe('');
  });
});

describe('RPL_CHANNELMODEIS (324)', () => {
  it('resets + populates channel modes from Args (channel in Args[0])', () => {
    const { chat, session } = build();
    mode(session, ['+i']); // pre-existing flag should be cleared by the 324 snapshot
    session.emit({ Kind: '324', From: 's', Target: '', Args: ['#t', '+mk', 'secret'], Message: '', Raw: '' });
    const m = chan(chat).modes!;
    expect(m.flags).toEqual(['m']);
    expect(m.key).toBe('secret');
    expect(m.flags).not.toContain('i');
  });
});

describe('ban list (367 / 368)', () => {
  it('accumulates 367 entries and commits on 368, clearing loading', () => {
    const { chat, session } = build();
    chat.requestBanList('#t');
    expect(chan(chat).banListLoading).toBe(true);
    expect(session.raws).toContain('MODE #t +b');
    session.emit({ Kind: '367', From: 's', Target: '', Args: ['#t', 'troll!*@*', 'op', '1700000000'], Message: '', Raw: '' });
    session.emit({ Kind: '367', From: 's', Target: '', Args: ['#t', '*!*@1.2.3.4'], Message: '', Raw: '' });
    session.emit({ Kind: '368', From: 's', Target: '', Args: ['#t'], Message: 'End of ban list', Raw: '' });
    const bans = chan(chat).bans!;
    expect(bans).toHaveLength(2);
    expect(bans[0]).toMatchObject({ mask: 'troll!*@*', setBy: 'op', setAt: 1700000000 * 1000 });
    expect(bans[1]!.mask).toBe('*!*@1.2.3.4');
    expect(chan(chat).banListLoading).toBe(false);
  });

  it('applies live +b / -b once the list is loaded', () => {
    const { chat, session } = build();
    chat.requestBanList('#t');
    session.emit({ Kind: '368', From: 's', Target: '', Args: ['#t'], Message: '', Raw: '' });
    expect(chan(chat).bans).toEqual([]);
    mode(session, ['+b', 'newbie!*@*']);
    expect(chan(chat).bans?.map((b) => b.mask)).toEqual(['newbie!*@*']);
    mode(session, ['-b', 'newbie!*@*']);
    expect(chan(chat).bans).toEqual([]);
  });
});

describe('ISUPPORT PREFIX / CHANMODES', () => {
  it('parses PREFIX= and CHANMODES= into serverInfo', () => {
    const { chat, session } = build();
    session.emit({ Kind: '005', From: 's', Target: 'Nyan', Args: ['PREFIX=(qaohv)~&@%+', 'CHANMODES=beI,k,l,imnpstn'], Message: 'are supported', Raw: '' });
    const info = chat.getState().serverInfo;
    expect(info.prefix).toEqual({ modes: 'qaohv', sigils: '~&@%+' });
    expect(info.chanModes).toEqual({ list: 'beI', param: 'k', paramSet: 'l', bool: 'imnpstn' });
  });
});

describe('myPrefix / myRank', () => {
  it('reflects our own status in the channel', () => {
    const { chat, session } = build();
    expect(chat.myRank('#t')).toBe(0);
    session.emit({ Kind: '353', From: 's', Target: '#t', Args: ['#t'], Message: 'Nyan', Raw: '' });
    session.emit({ Kind: '366', From: 's', Target: '#t', Args: ['#t'], Message: '', Raw: '' });
    mode(session, ['+o', 'Nyan']);
    expect(chat.myPrefix('#t')).toBe('@');
    expect(chat.myRank('#t')).toBe(3);
  });
});
