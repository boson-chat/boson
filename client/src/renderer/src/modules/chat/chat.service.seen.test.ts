import { describe, it, expect, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { SeenStore } from '../seen/seen.store';
import { __resetPrivacySettingsCache, setPrivacySettings } from '../ui/privacy.store';
import { MemoryChatHistoryStore } from '../history/memory-chat-history.store';

// Who people were after they've left: activity lines record the sender's
// user@host (and account / realname), and the seen store keeps each nick's
// latest identity from every source.

function makeChat(opts: { seen?: SeenStore; persistence?: ConstructorParameters<typeof ChatService>[2] } = {}) {
  let listener: EventListener | null = null;
  const raw: string[] = [];
  const session = {
    serverId: 'srv-test',
    join: () => {}, part: () => {}, privmsg: () => {},
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line: string) => { raw.push(line); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
  };
  const seen = opts.seen ?? new SeenStore('test', null, { enabled: () => true });
  const chat = new ChatService(session as unknown as ServerSession, 'me', opts.persistence, { seen });
  chat.attach();
  const emit = (e: Partial<IrcEvent>): void => listener?.({ Kind: '', From: '', Target: '', Message: '', Raw: '', ...e });
  const lines = (ch = '#lobby') => chat.getState().channels.find((c) => c.name === ch)!.messages;
  const join = (): void => {
    emit({ Kind: 'JOIN', From: 'me', Target: '#lobby' });
    emit({ Kind: '353', Target: '#lobby', Message: '@me bob' });
    emit({ Kind: '366', Target: '#lobby' });
  };
  return { chat, emit, lines, join, raw, seen };
}

afterEach(() => {
  localStorage.clear();
  __resetPrivacySettingsCache();
});

describe('activity lines carry the sender identity', () => {
  it('JOIN with extended-join: user, host, account, realname', () => {
    const { emit, lines, join, seen } = makeChat();
    join();
    emit({ Kind: 'JOIN', From: 'WittyQuail', Target: '#lobby', User: '~WittyQuail', Host: '101.128.125.37', Account: 'wq', Message: 'Witty Quail' });
    expect(lines().at(-1)).toMatchObject({
      kind: 'join', from: 'WittyQuail', text: 'WittyQuail joined',
      user: '~WittyQuail', host: '101.128.125.37', account: 'wq', realname: 'Witty Quail',
    });
    expect(seen.get('wittyquail')).toMatchObject({
      user: '~WittyQuail', host: '101.128.125.37', account: 'wq', realname: 'Witty Quail', channels: ['#lobby'],
    });
  });

  it('PART and QUIT: the prefix, topped up from the member record', () => {
    const { emit, lines, join, seen } = makeChat();
    join();
    emit({ Kind: 'JOIN', From: 'carol', Target: '#lobby', User: 'c', Host: 'carol.host', Account: 'carola', Message: 'Carol' });
    emit({ Kind: 'PART', From: 'carol', Target: '#lobby', User: 'c', Host: 'carol.host' });
    expect(lines().at(-1)).toMatchObject({ kind: 'part', user: 'c', host: 'carol.host', account: 'carola', realname: 'Carol' });
    emit({ Kind: 'JOIN', From: 'carol', Target: '#lobby', User: 'c', Host: 'carol.host' });
    emit({ Kind: 'QUIT', From: 'carol', User: 'c', Host: 'carol.host', Message: 'bye' });
    expect(lines().at(-1)).toMatchObject({ kind: 'quit', text: 'carol quit (bye)', user: 'c', host: 'carol.host' });
    expect(seen.get('carol')).toMatchObject({ host: 'carol.host', account: 'carola', realname: 'Carol' });
  });

  it('KICK: the kicker on the line; the kicked nick remembered from the member list', () => {
    const { emit, lines, join, seen } = makeChat();
    join();
    emit({ Kind: '352', Target: '#lobby', From: 'bob', User: '~bob', Host: 'bob.host', Args: ['H', 'irc.x'], Message: '0 Bob B' });
    emit({ Kind: 'KICK', From: 'op', User: 'o', Host: 'op.host', Target: '#lobby', Args: ['bob'], Message: 'out' });
    expect(lines().at(-1)).toMatchObject({ kind: 'kick', from: 'op', user: 'o', host: 'op.host' });
    expect(seen.get('bob')).toMatchObject({ user: '~bob', host: 'bob.host', realname: 'Bob B', channels: ['#lobby'] });
    expect(seen.get('op')).toMatchObject({ host: 'op.host' });
  });

  it('nothing is recorded on lines while remembering hosts is off', () => {
    setPrivacySettings({ rememberHosts: false });
    const { emit, lines, join, seen } = makeChat({ seen: new SeenStore('off') });
    join();
    emit({ Kind: 'JOIN', From: 'dave', Target: '#lobby', User: 'd', Host: 'dave.host', Account: 'dave', Message: 'Dave' });
    const m = lines().at(-1)!;
    expect(m.kind).toBe('join');
    expect(m.host).toBeUndefined();
    expect(m.user).toBeUndefined();
    expect(seen.size).toBe(0);
  });

  it('the identity survives local history (rowToMessage) and the reconnect handoff', async () => {
    const history = new MemoryChatHistoryStore();
    const persistence = { history, scope: { userId: 'u', serverId: 'srv-test' } };
    const { emit, join, chat } = makeChat({ persistence });
    join();
    emit({ Kind: 'JOIN', From: 'eve', Target: '#lobby', User: 'e', Host: 'eve.host' });
    await Promise.resolve();
    const stored = await history.load({ userId: 'u', serverId: 'srv-test', channel: '#lobby' });
    expect(stored.find((m) => m.kind === 'join')).toMatchObject({ user: 'e', host: 'eve.host' });
    const carried = chat.exportConversations().find((c) => c.name === '#lobby')!;
    expect(carried.messages.find((m) => m.kind === 'join')).toMatchObject({ host: 'eve.host' });
  });
});

describe('the seen store hears every source', () => {
  it('WHO, PRIVMSG prefix, CHGHOST, SETNAME, ACCOUNT', () => {
    const { emit, join, seen } = makeChat();
    join();
    emit({ Kind: '352', Target: '#lobby', From: 'bob', User: '~bob', Host: 'h1', Args: ['H', 'irc.x'], Message: '0 Bob' });
    expect(seen.get('bob')).toMatchObject({ user: '~bob', host: 'h1', realname: 'Bob' });
    emit({ Kind: 'PRIVMSG', From: 'bob', User: '~bob', Host: 'h1', Account: 'bobby', Target: '#lobby', Message: 'hi' });
    expect(seen.get('bob')).toMatchObject({ account: 'bobby', channels: ['#lobby'] });
    emit({ Kind: 'CHGHOST', From: 'bob', User: 'bob', Host: 'user/bob' });
    expect(seen.get('bob')).toMatchObject({ user: 'bob', host: 'user/bob', prevHosts: ['~bob@h1'] });
    emit({ Kind: 'SETNAME', From: 'bob', Message: 'Robert' });
    expect(seen.get('bob')!.realname).toBe('Robert');
    emit({ Kind: 'ACCOUNT', From: 'bob', Account: '' });
    expect(seen.get('bob')!.account).toBeUndefined();
  });

  it('userhost-in-names', () => {
    const { emit, seen } = makeChat();
    emit({ Kind: 'JOIN', From: 'me', Target: '#lobby' });
    emit({ Kind: '353', Target: '#lobby', Message: '@zed!z@zed.host me!m@me.host' });
    emit({ Kind: '366', Target: '#lobby' });
    expect(seen.get('zed')).toMatchObject({ user: 'z', host: 'zed.host' });
    expect(seen.get('me')).toBeUndefined(); // never ourselves
  });

  it('a NICK change carries the identity over', () => {
    const { emit, join, seen } = makeChat();
    join();
    emit({ Kind: 'JOIN', From: 'alice', Target: '#lobby', User: 'a', Host: 'alice.host' });
    emit({ Kind: 'NICK', From: 'alice', User: 'a', Host: 'alice.host', Message: 'alice2' });
    expect(seen.get('alice2')).toMatchObject({ nick: 'alice2', host: 'alice.host', channels: ['#lobby'] });
    expect(seen.get('alice')).toMatchObject({ host: 'alice.host' });
  });

  it('a WHOIS: user, host, realname, account, actual host', () => {
    const { chat, emit, seen } = makeChat();
    chat.requestWhois('frank');
    emit({ Kind: '311', Args: ['frank', '~f', 'frank.cloak', '*'], Message: 'Frank' });
    emit({ Kind: '330', Args: ['frank', 'franka'], Message: 'is logged in as' });
    emit({ Kind: '338', Args: ['frank', '198.51.100.4', 'actually using host'], Message: 'actually using host' });
    emit({ Kind: '318', Args: ['frank'], Message: 'End of /WHOIS list' });
    const r = seen.get('frank')!;
    expect(r).toMatchObject({ user: '~f', host: 'frank.cloak', realname: 'Frank', account: 'franka', actualHost: '198.51.100.4' });
    expect(r.lastWhoisAt).toBeGreaterThan(0);
  });

  it('chathistory replays: the prefix, as of the line, without overwriting newer', () => {
    const { emit, join, seen } = makeChat();
    join();
    emit({ Kind: 'PRIVMSG', From: 'gus', User: 'g', Host: 'new.host', Target: '#lobby', Message: 'now' });
    emit({ Kind: 'BATCH', Args: ['+b1', 'chathistory', '#lobby'] });
    emit({
      Kind: 'PRIVMSG', From: 'gus', User: 'g', Host: 'old.host', Target: '#lobby', Message: 'then',
      Tags: { batch: 'b1', time: '2020-01-01T00:00:00.000Z' },
    });
    emit({
      Kind: 'PRIVMSG', From: 'hal', User: 'h', Host: 'hal.host', Target: '#lobby', Message: 'old',
      Tags: { batch: 'b1', time: '2020-01-01T00:00:01.000Z' },
    });
    emit({ Kind: 'BATCH', Args: ['-b1'] });
    expect(seen.get('gus')!.host).toBe('new.host');
    expect(seen.get('hal')).toMatchObject({ host: 'hal.host', lastSeenAt: Date.parse('2020-01-01T00:00:01.000Z') });
  });
});

describe('/seen and /whois on someone gone', () => {
  it('/seen prints the remembered record into the open buffer (not saved)', () => {
    const { chat, emit, join, lines } = makeChat();
    join();
    emit({ Kind: 'JOIN', From: 'ivy', Target: '#lobby', User: '~ivy', Host: 'ivy.host', Account: 'ivy', Message: 'Ivy' });
    emit({ Kind: 'QUIT', From: 'ivy', User: '~ivy', Host: 'ivy.host', Message: 'bye' });
    chat.input('/seen IVY');
    expect(lines().at(-1)!.text).toBe('Remembered: ivy (~ivy@ivy.host) was last seen just now in #lobby · account ivy · real name Ivy');
  });

  it('/seen for a stranger says so', () => {
    const { chat, join, lines } = makeChat();
    join();
    chat.input('/seen nobody');
    expect(lines().at(-1)!.text).toBe("Boson doesn't remember nobody.");
  });

  it('a typed /whois that 401s shows what we remember, marked as remembered', () => {
    const { chat, emit, join, lines, raw } = makeChat();
    join();
    emit({ Kind: 'JOIN', From: 'jo', Target: '#lobby', User: 'j', Host: 'jo.host' });
    emit({ Kind: 'PART', From: 'jo', Target: '#lobby', User: 'j', Host: 'jo.host' });
    chat.input('/whois jo');
    expect(raw).toContain('WHOIS jo');
    emit({ Kind: '401', Args: ['jo'], Message: 'No such nick/channel' });
    expect(lines().at(-1)!.text).toMatch(/^jo isn't on the network\. Remembered: jo \(j@jo\.host\) was last seen/);
    // A later, untyped 401 for jo (e.g. messaging them) prints nothing.
    const n = lines().length;
    emit({ Kind: '401', Args: ['jo'], Message: 'No such nick/channel' });
    expect(lines().length).toBe(n);
  });
});
