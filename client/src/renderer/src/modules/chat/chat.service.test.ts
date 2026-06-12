import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChatService } from './chat.service';
import { SERVICE_CHANNEL } from './services';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';

// FakeServerSession mirrors the ServerSession surface ChatService consumes.
// Tests drive incoming events via emit() and inspect outgoing commands via
// the *Calls fields.
interface FakeServerSession extends Pick<ServerSession, 'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' | 'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' | 'onServicesFramework' | 'servicesFramework' | 'serverId'> {
  emit(e: IrcEvent): void;
  emitDirectory(entries: { name: string; userCount: number; topic: string }[]): void;
  emitServicesFramework(fw: 'atheme' | 'anope' | 'ergo' | 'unknown'): void;
  joinCalls: string[];
  partCalls: string[];
  privmsgCalls: Array<{ target: string; message: string }>;
  namesCalls: string[];
  tagmsgCalls: Array<{ target: string; tags: Record<string, string> }>;
  listCalls: number;
  awayCalls: Array<{ message: string }>;
  nickCalls: string[];
  nickservIdentifyCalls: string[];
  rawCalls: string[];
}

function fakeSession(serverId = 'srv-test'): FakeServerSession {
  let listener: EventListener | null = null;
  let directoryListener: ((entries: { name: string; userCount: number; topic: string }[]) => void) | null = null;
  let servicesListener: ((fw: 'atheme' | 'anope' | 'ergo' | 'unknown') => void) | null = null;
  let currentFramework: 'atheme' | 'anope' | 'ergo' | 'unknown' | null = null;
  const f: FakeServerSession = {
    serverId,
    joinCalls: [],
    partCalls: [],
    privmsgCalls: [],
    namesCalls: [],
    tagmsgCalls: [],
    listCalls: 0,
    awayCalls: [],
    nickCalls: [],
    nickservIdentifyCalls: [],
    rawCalls: [],
    join: (channel: string) => { f.joinCalls.push(channel); },
    part: (channel: string) => { f.partCalls.push(channel); },
    privmsg: (target: string, message: string) => { f.privmsgCalls.push({ target, message }); },
    names: (channel: string) => { f.namesCalls.push(channel); },
    tagmsg: (target: string, tags: Record<string, string>) => { f.tagmsgCalls.push({ target, tags }); },
    list: () => { f.listCalls += 1; },
    away: (message: string) => { f.awayCalls.push({ message }); },
    nick: (nick: string) => { f.nickCalls.push(nick); },
    nickservIdentify: (password: string) => { f.nickservIdentifyCalls.push(password); },
    raw: (line: string) => { f.rawCalls.push(line); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: (fn) => { directoryListener = fn; return () => { directoryListener = null; }; },
    onServicesFramework: (fn) => {
      servicesListener = fn;
      if (currentFramework !== null) fn(currentFramework);
      return () => { servicesListener = null; };
    },
    servicesFramework: () => currentFramework,
    emit: (e) => listener?.(e),
    emitDirectory: (entries) => directoryListener?.(entries),
    emitServicesFramework: (fw) => { currentFramework = fw; servicesListener?.(fw); },
  };
  return f;
}
let fakeSessionInstance: FakeServerSession;

function makeEvent(partial: Partial<IrcEvent>): IrcEvent {
  return { Kind: '', From: '', Target: '', Message: '', Raw: '', ...partial };
}

function makeChat(nick = 'me'): { chat: ChatService; engine: FakeServerSession } {
  fakeSessionInstance = fakeSession();
  const chat = new ChatService(fakeSessionInstance as unknown as ServerSession, nick);
  chat.attach();
  return { chat, engine: fakeSessionInstance };
}

describe('ChatService', () => {
  beforeEach(() => { vi.useRealTimers(); });

  it('starts with no channels and no active channel', () => {
    const { chat } = makeChat();
    expect(chat.getState().channels).toEqual([]);
    expect(chat.getState().activeChannel).toBeNull();
  });

  it('join() forwards to engine and prepends # if missing', () => {
    const { chat, engine } = makeChat();
    chat.join('general');
    expect(engine.joinCalls).toEqual(['#general']);
  });

  it('join() preserves a leading #', () => {
    const { chat, engine } = makeChat();
    chat.join('#dev');
    expect(engine.joinCalls).toEqual(['#dev']);
  });

  it('input() routes plain text to the active channel', () => {
    const { chat, engine } = makeChat('me');
    chat.join('#general');
    engine.privmsgCalls.length = 0;
    chat.input('hello world');
    expect(engine.privmsgCalls).toEqual([{ target: '#general', message: 'hello world' }]);
  });

  it('input() with leading // sends a literal line starting with /', () => {
    const { chat, engine } = makeChat('me');
    chat.join('#general');
    engine.privmsgCalls.length = 0;
    chat.input('//join');
    expect(engine.privmsgCalls).toEqual([{ target: '#general', message: '/join' }]);
  });

  it('/join command joins a channel', () => {
    const { chat, engine } = makeChat('me');
    chat.input('/join #help');
    expect(engine.joinCalls).toEqual(['#help']);
    expect(chat.getState().activeChannel).toBe('#help');
  });

  it('/part with no arg parts the active channel', () => {
    const { chat, engine } = makeChat('me');
    chat.join('#general');
    chat.input('/part');
    expect(engine.partCalls).toEqual(['#general']);
  });

  it('/msg <nick> <text> opens a DM and sends', () => {
    const { chat, engine } = makeChat('me');
    chat.input('/msg alice hello there');
    expect(engine.privmsgCalls).toEqual([{ target: 'alice', message: 'hello there' }]);
    expect(chat.getState().activeChannel).toBe('alice');
  });

  it('/me wraps text as CTCP ACTION and echoes with kind=action', () => {
    const { chat, engine } = makeChat('me');
    chat.join('#general');
    engine.privmsgCalls.length = 0;
    chat.input('/me waves');
    const stx = String.fromCharCode(1);
    expect(engine.privmsgCalls).toEqual([{ target: '#general', message: `${stx}ACTION waves${stx}` }]);
    const echo = chat.getState().channels[0]!.messages.at(-1)!;
    expect(echo.kind).toBe('action');
    expect(echo.text).toBe('waves');
  });

  it('/clear empties the active channel\'s message buffer', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#general', Message: 'hi' }));
    expect(chat.getState().channels[0]!.messages.length).toBeGreaterThan(0);
    chat.input('/clear');
    expect(chat.getState().channels[0]!.messages).toEqual([]);
  });

  it('unknown /command emits an error feedback event (not a chat message)', () => {
    const { chat, engine } = makeChat('me');
    chat.join('#general');
    const events: Array<{ kind: string; text?: string }> = [];
    chat.onFeedback((f) => events.push(f));
    chat.input('/sploosh');
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('error');
    expect(events[0]!.text).toContain('Unknown command');
    // Chat log stays clean — feedback is out-of-band.
    expect(chat.getState().channels[0]!.messages.find((m) => m.kind === 'system' && m.text.includes('Unknown'))).toBeUndefined();
    expect(engine.privmsgCalls).toEqual([]);
  });

  it('/help emits a help feedback event with the full command list', () => {
    const { chat } = makeChat('me');
    chat.join('#general');
    const events: Array<{ kind: string }> = [];
    chat.onFeedback((f) => events.push(f));
    chat.input('/help');
    const help = events.find((e) => e.kind === 'help');
    expect(help).toBeDefined();
  });

  it('incoming CTCP ACTION is decoded into kind=action', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    const stx = String.fromCharCode(1);
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#general', Message: `${stx}ACTION dances${stx}` }));
    const last = chat.getState().channels[0]!.messages.at(-1)!;
    expect(last.kind).toBe('action');
    expect(last.text).toBe('dances');
    expect(last.from).toBe('alice');
  });

  it('NAMREPLY + ENDOFNAMES populate a channel\'s member list with prefixes', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#general', Message: '@alice +bob charlie' }));
    expect(chat.getState().channels[0]!.members).toEqual([]); // not committed yet
    engine.emit(makeEvent({ Kind: '366', Target: '#general' }));
    expect(chat.getState().channels[0]!.members).toEqual([
      { nick: 'alice', prefix: '@' },
      { nick: 'bob',   prefix: '+' },
      { nick: 'charlie', prefix: '' },
    ]);
  });

  it('NAMREPLY strips userhost-in-names suffix and multi-prefix sigils', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({
      Kind: '353',
      Target: '#general',
      Message: '~&james!james@host1 @alice!alice@host2 +bob',
    }));
    engine.emit(makeEvent({ Kind: '366', Target: '#general' }));
    const members = chat.getState().channels[0]!.members;
    expect(members).toEqual([
      { nick: 'james', prefix: '~', hostname: 'host1' },
      { nick: 'alice', prefix: '@', hostname: 'host2' },
      { nick: 'bob',   prefix: '+' },
    ]);
  });

  it('NAMREPLY for two channels populates both independently', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#alpha' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#beta' }));
    // Interleave NAMREPLY for both — burst delivery from the server.
    engine.emit(makeEvent({ Kind: '353', Target: '#alpha', Message: '@ann alice' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#beta',  Message: '+bob beth' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#alpha' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#beta' }));
    const channels = chat.getState().channels;
    const alpha = channels.find((c) => c.name === '#alpha')!;
    const beta  = channels.find((c) => c.name === '#beta')!;
    expect(alpha.members.map((m) => m.nick).sort()).toEqual(['alice', 'ann']);
    expect(beta.members.map((m) => m.nick).sort()).toEqual(['beth', 'bob']);
  });

  it('NAMREPLY with server-canonical casing lands on the user-typed channel (case-insensitive key)', () => {
    const { chat, engine } = makeChat('me');
    chat.join('#General'); // user types mixed case
    // Server echoes JOIN + NAMREPLY using its canonical case, which can differ.
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#general', Message: '@alice bob' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#general' }));
    const channels = chat.getState().channels;
    expect(channels).toHaveLength(1); // not two records under different casings
    expect(channels[0]!.members.map((m) => m.nick).sort()).toEqual(['alice', 'bob']);
  });

  it('NAMREPLY accumulates across multiple chunks for the same channel', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#big' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#big', Message: '@op1 user1' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#big', Message: '+voice1 user2' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#big' }));
    expect(chat.getState().channels[0]!.members.map((m) => m.nick).sort())
      .toEqual(['op1', 'user1', 'user2', 'voice1']);
  });

  it('JOIN from another user adds them to the channel\'s member list', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'alice', Target: '#general' }));
    const members = chat.getState().channels[0]!.members;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ nick: 'alice', prefix: '' });
    expect(members[0]!.joinedAt).toEqual(expect.any(Number));
  });

  it('PRIVMSG from a member bumps their lastActiveAt across channels', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#b' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'alice', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'alice', Target: '#b' }));
    const before = Date.now() - 1;
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hi' }));
    const channels = chat.getState().channels;
    const aliceInA = channels.find((c) => c.name === '#a')!.members.find((m) => m.nick === 'alice')!;
    const aliceInB = channels.find((c) => c.name === '#b')!.members.find((m) => m.nick === 'alice')!;
    expect(aliceInA.lastActiveAt).toBeGreaterThanOrEqual(before);
    expect(aliceInB.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  it('PART from another user removes them from the member list', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'alice', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'PART', From: 'alice', Target: '#general' }));
    expect(chat.getState().channels[0]!.members).toEqual([]);
  });

  it('QUIT removes the user from every channel\'s member list', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#b' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'alice', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'alice', Target: '#b' }));
    engine.emit(makeEvent({ Kind: 'QUIT', From: 'alice', Message: 'gone' }));
    const channels = chat.getState().channels;
    expect(channels.find((c) => c.name === '#a')!.members).toEqual([]);
    expect(channels.find((c) => c.name === '#b')!.members).toEqual([]);
  });

  it('NICK renames the user across every channel\'s member list', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#a', Message: '@oldnick alice' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'NICK', From: 'oldnick', Message: 'newnick' }));
    const members = chat.getState().channels[0]!.members;
    expect(members.find((m) => m.nick === 'newnick')).toEqual({ nick: 'newnick', prefix: '@' });
    expect(members.find((m) => m.nick === 'oldnick')).toBeUndefined();
  });

  it('join() auto-switches activeChannel to the joined channel', () => {
    const { chat, engine } = makeChat('me');
    // First channel becomes active on first join.
    chat.join('#first');
    expect(chat.getState().activeChannel).toBe('#first');
    // Joining a second channel switches focus to the new one even though
    // #first is already active — matches Discord/Slack expectations.
    chat.join('#second');
    expect(chat.getState().activeChannel).toBe('#second');
    expect(engine.joinCalls).toEqual(['#first', '#second']);
  });

  it('JOIN event from our own nick creates a joined channel and sets it active', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    const state = chat.getState();
    expect(state.channels).toHaveLength(1);
    expect(state.channels[0]!.name).toBe('#general');
    expect(state.channels[0]!.joined).toBe(true);
    expect(state.activeChannel).toBe('#general');
  });

  it('JOIN event from another user appears in the channel log', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'alice', Target: '#general' }));

    const ch = chat.getState().channels[0]!;
    const joinMsg = ch.messages.find((m) => m.kind === 'join' && m.from === 'alice');
    expect(joinMsg).toBeDefined();
  });

  it('PRIVMSG to a channel is logged with kind=message', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#general', Message: 'hi' }));

    const messages = chat.getState().channels[0]!.messages;
    const m = messages.find((x) => x.kind === 'message');
    expect(m).toBeDefined();
    expect(m!.from).toBe('alice');
    expect(m!.text).toBe('hi');
  });

  it('PRIVMSG directed at our nick lands in a channel keyed by sender (DM)', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: 'me', Message: 'psst' }));

    const state = chat.getState();
    const dm = state.channels.find((c) => c.name === 'alice');
    expect(dm).toBeDefined();
    expect(dm!.messages.at(-1)!.text).toBe('psst');
  });

  it('NOTICE from a service lands in the ~server log, not a DM-shaped channel', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'NOTICE', From: 'NickServ', Target: 'me', Message: 'identified' }));

    // Service chatter (other than MemoServ memos) is transactional: it goes to
    // the quiet ~server pseudo-channel, NOT a per-service DM-shaped channel and
    // NOT the global Inbox (the Inbox is MemoServ memos + real DMs only — see
    // chat.service.memos.test.ts).
    const chans = chat.getState().channels;
    expect(chans.find((c) => c.name === 'NickServ')).toBeUndefined();
    const serverCh = chans.find((c) => c.name === SERVICE_CHANNEL);
    expect(serverCh?.messages.some((m) => m.from === 'NickServ' && m.text === 'identified')).toBe(true);
  });

  it('NOTICE with target="*" lands in ~server, NOT a real chat channel', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'NOTICE', From: 'server.example', Target: '*', Message: 'Looking up your hostname...' }));
    const chans = chat.getState().channels;
    // Only the ~server pseudo-channel should exist; no real # or & channels
    // and no DM-shaped virtual channels.
    expect(chans.map((c) => c.name)).toEqual(['~server']);
  });

  it('PRIVMSG with target="*" also routes to ~server (pre-reg bogus)', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'server.example', Target: '*', Message: 'bogus' }));
    expect(chat.getState().channels.map((c) => c.name)).toEqual(['~server']);
  });

  it('PRIVMSG with a target that\'s neither us, a channel, nor a wildcard is dropped entirely', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'someone', Target: 'someoneelse', Message: 'not for me' }));
    expect(chat.getState().channels).toEqual([]);
  });

  it('~server pseudo-channel does NOT bump unread or mention counters', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    chat.setActive('#general');
    chat.setForeground(true);
    // A server-wildcard notice populates ~server (service messages addressed
    // to us now route to the Inbox, so use the wildcard path here).
    engine.emit(makeEvent({ Kind: 'NOTICE', From: 'server.example', Target: '*', Message: 'hi' }));
    const ch = chat.getState().channels.find((c) => c.name === '~server')!;
    expect(ch.unread).toBe(0);
    expect(ch.mentions).toBe(0);
  });

  it('send() optimistically echoes our own message', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    chat.send('#general', 'hello');

    expect(engine.privmsgCalls).toEqual([{ target: '#general', message: 'hello' }]);
    const messages = chat.getState().channels[0]!.messages;
    const mine = messages.find((m) => m.kind === 'message' && m.from === 'me');
    expect(mine).toBeDefined();
    expect(mine!.text).toBe('hello');
  });

  it('send() ignores empty or whitespace-only messages', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    chat.send('#general', '   ');
    expect(engine.privmsgCalls).toEqual([]);
  });

  it('PART from our nick removes the channel', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    expect(chat.getState().channels).toHaveLength(1);
    engine.emit(makeEvent({ Kind: 'PART', From: 'me', Target: '#general' }));
    expect(chat.getState().channels).toHaveLength(0);
  });

  it('PART from another user just logs in the channel', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'PART', From: 'alice', Target: '#general' }));
    const ch = chat.getState().channels[0]!;
    expect(ch.messages.find((m) => m.kind === 'part' && m.from === 'alice')).toBeDefined();
  });

  it('QUIT appears only in channels where the quitting nick was a member', () => {
    const { chat, engine } = makeChat('me');
    // Two joined channels, both with our user; only #general also has alice.
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#dev' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#general', Message: 'me alice' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#general' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#dev',     Message: 'me bob' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#dev' }));
    engine.emit(makeEvent({ Kind: 'QUIT', From: 'alice', Message: 'goodbye' }));

    const channels = chat.getState().channels;
    const general = channels.find((c) => c.name === '#general')!;
    const dev = channels.find((c) => c.name === '#dev')!;
    expect(general.messages.some((m) => m.kind === 'quit' && m.from === 'alice')).toBe(true);
    expect(dev.messages.some((m) => m.kind === 'quit' && m.from === 'alice')).toBe(false);
  });

  it('QUIT still removes the nick from every channel member list (even ones without the quit message)', () => {
    // Defensive: presence-tracking has to stay correct even when we
    // skip the visible system message. A stale "alice" in #dev's member
    // list would surface as a ghost.
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#general', Message: 'me alice' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'QUIT', From: 'alice', Message: '' }));

    const general = chat.getState().channels.find((c) => c.name === '#general')!;
    expect(general.members.some((m) => m.nick === 'alice')).toBe(false);
  });

  it('setActive() updates the active channel and notifies subscribers', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#b' }));

    const observed: Array<string | null> = [];
    chat.subscribe((s) => observed.push(s.activeChannel));

    chat.setActive('#b');
    expect(chat.getState().activeChannel).toBe('#b');
    expect(observed).toContain('#b');
  });

  it('part() removes the channel and clears activeChannel if it was active', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    expect(chat.getState().activeChannel).toBe('#a');

    chat.part('#a');
    expect(chat.getState().channels).toHaveLength(0);
    expect(chat.getState().activeChannel).toBeNull();
  });

  it('detach() stops processing engine events', () => {
    const { chat, engine } = makeChat();
    chat.detach();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    expect(chat.getState().channels).toHaveLength(0);
  });

  it('subscribe() fires immediately with current state', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));

    let received: { channels: number; active: string | null } | null = null;
    chat.subscribe((s) => { received = { channels: s.channels.length, active: s.activeChannel }; });
    expect(received).toEqual({ channels: 1, active: '#a' });
  });
});

// ---------------------------------------------------------------------------
// IRCv3 +typing client-tag. Receive side: TAGMSG with `+typing=active` adds
// the sender to that channel's typing list; `done`/`paused` removes them;
// auto-expires after 6s with no refresh; arriving PRIVMSG clears them too.
// Send side: sendTyping() emits a TAGMSG, with `active` throttled to one
// per 3s and `done` always firing.
describe('ChatService typing indicator', () => {
  beforeEach(() => { vi.useRealTimers(); });

  function joinChannel(chat: ChatService, engine: FakeServerSession, channel: string) {
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: channel }));
    // Lets the channel record settle.
    void chat;
  }

  it('marks a remote nick typing on +typing=active TAGMSG', () => {
    const { chat, engine } = makeChat();
    joinChannel(chat, engine, '#a');
    engine.emit(makeEvent({
      Kind: 'TAGMSG', From: 'alice', Target: '#a',
      Tags: { '+typing': 'active' },
    }));
    expect(chat.getState().channels[0]!.typing).toEqual(['alice']);
  });

  it('clears the typer on +typing=done', () => {
    const { chat, engine } = makeChat();
    joinChannel(chat, engine, '#a');
    engine.emit(makeEvent({ Kind: 'TAGMSG', From: 'alice', Target: '#a', Tags: { '+typing': 'active' } }));
    engine.emit(makeEvent({ Kind: 'TAGMSG', From: 'alice', Target: '#a', Tags: { '+typing': 'done' } }));
    expect(chat.getState().channels[0]!.typing).toEqual([]);
  });

  it('does NOT add ourselves on echoed TAGMSG (server-echo / loopback)', () => {
    const { chat, engine } = makeChat('me');
    joinChannel(chat, engine, '#a');
    engine.emit(makeEvent({ Kind: 'TAGMSG', From: 'me', Target: '#a', Tags: { '+typing': 'active' } }));
    expect(chat.getState().channels[0]!.typing).toEqual([]);
  });

  it('auto-clears an active typer after the 6s expiry window', () => {
    vi.useFakeTimers();
    const { chat, engine } = makeChat();
    joinChannel(chat, engine, '#a');
    engine.emit(makeEvent({ Kind: 'TAGMSG', From: 'alice', Target: '#a', Tags: { '+typing': 'active' } }));
    expect(chat.getState().channels[0]!.typing).toEqual(['alice']);
    vi.advanceTimersByTime(6_500);
    expect(chat.getState().channels[0]!.typing).toEqual([]);
  });

  it('a PRIVMSG from the typer clears their typing entry', () => {
    const { chat, engine } = makeChat();
    joinChannel(chat, engine, '#a');
    engine.emit(makeEvent({ Kind: 'TAGMSG', From: 'alice', Target: '#a', Tags: { '+typing': 'active' } }));
    expect(chat.getState().channels[0]!.typing).toEqual(['alice']);
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hi' }));
    expect(chat.getState().channels[0]!.typing).toEqual([]);
  });

  it('sendTyping("active") fires a +typing=active TAGMSG the first time', () => {
    const { chat, engine } = makeChat();
    joinChannel(chat, engine, '#a');
    chat.sendTyping('#a', 'active');
    expect(engine.tagmsgCalls).toEqual([{ target: '#a', tags: { '+typing': 'active' } }]);
  });

  it('sendTyping("active") is throttled — successive calls within 3s are dropped', () => {
    vi.useFakeTimers();
    const { chat, engine } = makeChat();
    joinChannel(chat, engine, '#a');
    chat.sendTyping('#a', 'active');
    chat.sendTyping('#a', 'active');
    vi.advanceTimersByTime(1_000);
    chat.sendTyping('#a', 'active');
    expect(engine.tagmsgCalls).toHaveLength(1);
    vi.advanceTimersByTime(3_500);
    chat.sendTyping('#a', 'active');
    expect(engine.tagmsgCalls).toHaveLength(2);
  });

  it('sendTyping("done") always fires, even right after an active', () => {
    const { chat, engine } = makeChat();
    joinChannel(chat, engine, '#a');
    chat.sendTyping('#a', 'active');
    chat.sendTyping('#a', 'done');
    expect(engine.tagmsgCalls).toEqual([
      { target: '#a', tags: { '+typing': 'active' } },
      { target: '#a', tags: { '+typing': 'done' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Server log capture. Every engine event the session forwards is appended to
// ChatState.serverLog before per-kind routing, so the UI can show the IRC
// handshake in real time. Capped at 200 entries; FIFO eviction; cleared via
// clearServerLog() which emits.
// ---------------------------------------------------------------------------
describe('ChatService serverLog', () => {
  it('appends every engine event to serverLog with kind/from/target/message captured', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'NOTICE', From: 'server.example', Target: '*', Message: 'looking up your hostname' }));
    engine.emit(makeEvent({ Kind: '001', From: 'server.example', Target: 'me', Message: 'Welcome to the network' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    const log = chat.getState().serverLog;
    expect(log.length).toBe(3);
    expect(log[0]).toMatchObject({ kind: 'NOTICE', from: 'server.example', target: '*', message: 'looking up your hostname' });
    expect(log[1]).toMatchObject({ kind: '001', from: 'server.example', target: 'me', message: 'Welcome to the network' });
    expect(log[2]).toMatchObject({ kind: 'JOIN', from: 'me', target: '#general' });
    // Every entry carries a non-empty id (monotonic from ChatService.id())
    // and a timestamp. Subsequent ids must differ.
    expect(log[0]!.id).not.toBe(log[1]!.id);
    expect(log[1]!.id).not.toBe(log[2]!.id);
    expect(log[0]!.timestamp).toEqual(expect.any(Number));
  });

  it('caps serverLog at 200 entries — oldest evicted first', () => {
    const { chat, engine } = makeChat();
    // Push 220 events; the cap is 200 so the first 20 should fall off.
    for (let i = 0; i < 220; i++) {
      engine.emit(makeEvent({ Kind: 'NOTICE', From: 'srv', Target: 'me', Message: `m${i}` }));
    }
    const log = chat.getState().serverLog;
    expect(log.length).toBe(200);
    // First retained entry should be m20 (since m0..m19 evicted).
    expect(log[0]!.message).toBe('m20');
    expect(log[log.length - 1]!.message).toBe('m219');
  });

  it('clearServerLog() empties the buffer and emits to subscribers', () => {
    const { chat, engine } = makeChat();
    const observed: number[] = [];
    chat.subscribe((s) => observed.push(s.serverLog.length));
    engine.emit(makeEvent({ Kind: 'NOTICE', From: 'srv', Target: 'me', Message: 'one' }));
    engine.emit(makeEvent({ Kind: 'NOTICE', From: 'srv', Target: 'me', Message: 'two' }));
    expect(chat.getState().serverLog.length).toBe(2);

    chat.clearServerLog();
    expect(chat.getState().serverLog).toEqual([]);
    // Subscriber should have observed the clear (last value 0).
    expect(observed.at(-1)).toBe(0);
  });

  it('clearServerLog() is a no-op (no extra emit) when the log is already empty', () => {
    const { chat } = makeChat();
    const observed: number[] = [];
    chat.subscribe((s) => observed.push(s.serverLog.length));
    const beforeCount = observed.length;
    chat.clearServerLog();
    // No new emit since nothing changed.
    expect(observed.length).toBe(beforeCount);
  });

  it('serverLog entries have unique monotonic ids (trivial dedupe by id)', () => {
    const { chat, engine } = makeChat();
    for (let i = 0; i < 10; i++) {
      engine.emit(makeEvent({ Kind: 'NOTICE', From: 'srv', Target: 'me', Message: `m${i}` }));
    }
    const ids = chat.getState().serverLog.map((e) => e.id);
    const uniq = new Set(ids);
    expect(uniq.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Persistence integration. ChatService gains an optional third constructor arg
// (`ChatPersistence`) — when present, joined channels hydrate from the store
// on first observation and every append is mirrored back. Tests below stub the
// store with MemoryChatHistoryStore so they run identically in happy-dom and
// in a real browser.
// ---------------------------------------------------------------------------

async function flushMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('ChatService persistence', () => {
  it('appended messages survive a "restart" via the shared history store', async () => {
    const history = new MemoryChatHistoryStore();
    const scope = { userId: 'u1', serverId: 's1' };

    // --- Session 1: join #a, append a couple of incoming messages.
    fakeSessionInstance = fakeSession();
    const chat1 = new ChatService(
      fakeSessionInstance as unknown as ServerSession,
      'me',
      { history, scope },
    );
    chat1.attach();
    fakeSessionInstance.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    fakeSessionInstance.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hi' }));
    fakeSessionInstance.emit(makeEvent({ Kind: 'PRIVMSG', From: 'bob', Target: '#a', Message: 'yo' }));
    // appendMessage fires the store call inside a microtask; drain it.
    await flushMicrotasks();
    chat1.detach();

    // --- Session 2: brand new ChatService, same history + scope. Rejoin the
    // channel and assert the prior messages reappear via hydration.
    fakeSessionInstance = fakeSession();
    const chat2 = new ChatService(
      fakeSessionInstance as unknown as ServerSession,
      'me',
      { history, scope },
    );
    chat2.attach();
    fakeSessionInstance.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    await flushMicrotasks();
    const messages = chat2.getState().channels[0]!.messages;
    // Expect both PRIVMSGs + the "you joined" system entries from BOTH sessions.
    const userMsgs = messages.filter((m) => m.kind === 'message');
    expect(userMsgs.map((m) => `${m.from}:${m.text}`).sort()).toEqual(['alice:hi', 'bob:yo']);
  });

  it('hydrated messages are prepended before in-session messages, deduped by id', async () => {
    const history = new MemoryChatHistoryStore();
    const scope = { userId: 'u1', serverId: 's1' };
    await history.append({ ...scope, channel: '#a' }, {
      id: 'persisted-1', kind: 'message', from: 'old', text: 'before', timestamp: 100,
    });

    fakeSessionInstance = fakeSession();
    const chat = new ChatService(
      fakeSessionInstance as unknown as ServerSession,
      'me',
      { history, scope },
    );
    chat.attach();
    fakeSessionInstance.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    fakeSessionInstance.emit(makeEvent({ Kind: 'PRIVMSG', From: 'new', Target: '#a', Message: 'after' }));
    await flushMicrotasks();

    const messages = chat.getState().channels[0]!.messages;
    const userMsgs = messages.filter((m) => m.kind === 'message');
    expect(userMsgs.map((m) => m.text)).toEqual(['before', 'after']);
  });

  it('rewrites duplicate persisted ids to unique values on hydrate', async () => {
    // Regression: older sessions wrote a monotonic counter as the message id,
    // so the same logical id ("4") could appear many times in the store after
    // multiple runs. Hydration must yield unique ids so Preact's reconciler
    // doesn't emit "two or more children with the same key" warnings.
    const history = new MemoryChatHistoryStore();
    const scope = { userId: 'u1', serverId: 's1' };
    await history.append({ ...scope, channel: '#a' }, {
      id: '4', kind: 'message', from: 'a', text: 'first', timestamp: 1,
    });
    await history.append({ ...scope, channel: '#a' }, {
      id: '4', kind: 'message', from: 'b', text: 'second', timestamp: 2,
    });
    await history.append({ ...scope, channel: '#a' }, {
      id: '4', kind: 'message', from: 'c', text: 'third', timestamp: 3,
    });

    fakeSessionInstance = fakeSession();
    const chat = new ChatService(
      fakeSessionInstance as unknown as ServerSession,
      'me',
      { history, scope },
    );
    chat.attach();
    fakeSessionInstance.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    await flushMicrotasks();

    const messages = chat.getState().channels[0]!.messages.filter((m) => m.kind === 'message');
    expect(messages.map((m) => m.text)).toEqual(['first', 'second', 'third']);
    const ids = messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('/clear wipes the persisted log too, so a restart no longer sees the messages', async () => {
    const history = new MemoryChatHistoryStore();
    const scope = { userId: 'u1', serverId: 's1' };

    fakeSessionInstance = fakeSession();
    const chat = new ChatService(
      fakeSessionInstance as unknown as ServerSession,
      'me',
      { history, scope },
    );
    chat.attach();
    fakeSessionInstance.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    fakeSessionInstance.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hi' }));
    await flushMicrotasks();

    chat.input('/clear');
    await flushMicrotasks();

    const persisted = await history.load({ ...scope, channel: '#a' });
    expect(persisted).toEqual([]);
  });

  it('hydration is suppressed on subsequent ensureChannel calls in the same session', async () => {
    const history = new MemoryChatHistoryStore();
    const scope = { userId: 'u1', serverId: 's1' };
    await history.append({ ...scope, channel: '#a' }, {
      id: 'persisted-1', kind: 'message', from: 'old', text: 'msg', timestamp: 100,
    });

    fakeSessionInstance = fakeSession();
    const chat = new ChatService(
      fakeSessionInstance as unknown as ServerSession,
      'me',
      { history, scope },
    );
    chat.attach();
    fakeSessionInstance.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    fakeSessionInstance.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'x' }));
    fakeSessionInstance.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'y' }));
    await flushMicrotasks();

    const userMsgs = chat
      .getState().channels[0]!
      .messages.filter((m) => m.kind === 'message');
    // Only one copy of the persisted message; no duplication despite the
    // multiple appendMessage calls that each invoke ensureChannel.
    const olds = userMsgs.filter((m) => m.text === 'msg');
    expect(olds).toHaveLength(1);
  });

  it('legacy 2-arg constructor disables persistence completely', async () => {
    const history = new MemoryChatHistoryStore();
    // Pre-seed the store; chat constructed without the third arg should
    // *not* see this message — proves the legacy code path stays in-memory.
    await history.append({ userId: 'u1', serverId: 's1', channel: '#a' }, {
      id: '1', kind: 'message', from: 'ghost', text: 'unseen', timestamp: 1,
    });
    fakeSessionInstance = fakeSession();
    const chat = new ChatService(fakeSessionInstance as unknown as ServerSession, 'me');
    chat.attach();
    fakeSessionInstance.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    await flushMicrotasks();
    const msgs = chat.getState().channels[0]!.messages;
    expect(msgs.find((m) => m.text === 'unseen')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Server-software identity. Captured from RPL_MYINFO (004) and the NETWORK=
// token in RPL_ISUPPORT (005). Surfaced via state.serverInfo for the chat
// header badge.
// ---------------------------------------------------------------------------
// Notification indicators: unread + mention counters on each channel,
// surfaced to the channel sidebar and server rail. Bumped on incoming
// PRIVMSG/NOTICE/ACTION when the channel ISN'T the active one; cleared on
// setActive() into the channel; own messages don't count.
describe('ChatService unread + mention tracking', () => {
  function joinAndSwitchAway(chat: ChatService, engine: FakeServerSession, ch: string, other: string) {
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: ch }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: other }));
    chat.setActive(other); // make sure `ch` is NOT the active channel
  }

  it('increments unread on a PRIVMSG to an inactive channel from someone else', () => {
    const { chat, engine } = makeChat('me');
    joinAndSwitchAway(chat, engine, '#a', '#b');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hello' }));
    const ch = chat.getState().channels.find((c) => c.name === '#a');
    expect(ch?.unread).toBe(1);
    expect(ch?.mentions).toBe(0);
  });

  it('also bumps mentions when the message contains our nick', () => {
    const { chat, engine } = makeChat('me');
    joinAndSwitchAway(chat, engine, '#a', '#b');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hey me, are you there?' }));
    const ch = chat.getState().channels.find((c) => c.name === '#a');
    expect(ch?.unread).toBe(1);
    expect(ch?.mentions).toBe(1);
  });

  it('does NOT increment when the channel IS active AND the server is foregrounded', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    chat.setActive('#a');
    chat.setForeground(true);
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hi me' }));
    const ch = chat.getState().channels.find((c) => c.name === '#a');
    expect(ch?.unread).toBe(0);
    expect(ch?.mentions).toBe(0);
  });

  it('STILL increments on the active channel when the server is NOT foregrounded', () => {
    // Even if this chat service has #a as its active channel, the user is
    // currently looking at a different server — so messages here are unread.
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    chat.setActive('#a');
    // foreground defaults to false; explicit for clarity:
    chat.setForeground(false);
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hey me' }));
    const ch = chat.getState().channels.find((c) => c.name === '#a');
    expect(ch?.unread).toBe(1);
    expect(ch?.mentions).toBe(1);
  });

  it('does NOT increment for our own messages even when on a different channel', () => {
    const { chat, engine } = makeChat('me');
    joinAndSwitchAway(chat, engine, '#a', '#b');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'me', Target: '#a', Message: 'self note' }));
    const ch = chat.getState().channels.find((c) => c.name === '#a');
    expect(ch?.unread).toBe(0);
  });

  it('clears unread + mentions when the user switches into the channel on a foregrounded server', () => {
    const { chat, engine } = makeChat('me');
    chat.setForeground(true);
    joinAndSwitchAway(chat, engine, '#a', '#b');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'hey me' }));
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'still talking' }));
    let ch = chat.getState().channels.find((c) => c.name === '#a');
    expect(ch?.unread).toBe(2);
    expect(ch?.mentions).toBe(1);

    chat.setActive('#a');
    ch = chat.getState().channels.find((c) => c.name === '#a');
    expect(ch?.unread).toBe(0);
    expect(ch?.mentions).toBe(0);
  });

  it('setForeground(true) clears the active channel\'s counters on flip-in', () => {
    const { chat, engine } = makeChat('me');
    joinAndSwitchAway(chat, engine, '#a', '#b'); // foreground=false here
    chat.setActive('#b');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#b', Message: 'hi' }));
    let ch = chat.getState().channels.find((c) => c.name === '#b');
    expect(ch?.unread).toBe(1);
    chat.setForeground(true);
    ch = chat.getState().channels.find((c) => c.name === '#b');
    expect(ch?.unread).toBe(0);
  });

  it('counts a DM from a brand-new sender as unread + mention even before the channel exists', () => {
    // Regression: bumpUnread runs BEFORE appendMessage, so for a DM from a
    // never-seen sender the channel record didn't yet exist and the bump
    // was silently dropped. bumpUnread must ensureChannel itself.
    const { chat, engine } = makeChat('me');
    // No prior interaction with 'stranger'. Send a DM (PRIVMSG to our nick).
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'stranger', Target: 'me', Message: 'hey' }));
    const ch = chat.getState().channels.find((c) => c.name === 'stranger');
    expect(ch).toBeDefined();
    expect(ch?.unread).toBe(1);
    // DMs are always mentions (1:1 conversations are inherently directed),
    // even when the message text doesn't contain our nick.
    expect(ch?.mentions).toBe(1);
  });

  it('every DM is treated as a mention, regardless of message text', () => {
    const { chat, engine } = makeChat('me');
    chat.setForeground(true);
    // Make some other channel active so the DM isn't suppressed.
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    chat.setActive('#general');
    // DM with no mention of "me" in the text.
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: 'me', Message: 'plain text, no name' }));
    const ch = chat.getState().channels.find((c) => c.name === 'alice');
    expect(ch?.unread).toBe(1);
    expect(ch?.mentions).toBe(1);
  });

  it('mention word-boundary check ignores substrings (al inside almost should not count)', () => {
    const { chat, engine } = makeChat('al');
    joinAndSwitchAway(chat, engine, '#a', '#b');
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'alice', Target: '#a', Message: 'almost there' }));
    const ch = chat.getState().channels.find((c) => c.name === '#a');
    expect(ch?.unread).toBe(1);
    expect(ch?.mentions).toBe(0);
  });
});

describe('ChatService server info capture', () => {
  it('captures server name + version from RPL_MYINFO (004)', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({
      Kind: '004', From: 'hub.example.org',
      Args: ['hub.example.org', 'solanum-1.0-dev'],
    }));
    expect(chat.getState().serverInfo).toEqual({
      serverName: 'hub.example.org',
      version: 'solanum-1.0-dev',
    });
  });

  it('merges NETWORK from a later RPL_ISUPPORT (005) without losing prior info', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({
      Kind: '004', From: 'hub.example.org',
      Args: ['hub.example.org', 'solanum-1.0-dev'],
    }));
    engine.emit(makeEvent({
      Kind: '005', From: 'hub.example.org',
      Args: ['CHANTYPES=#&', 'NETWORK=Libera.Chat', 'CASEMAPPING=rfc1459'],
    }));
    expect(chat.getState().serverInfo).toEqual({
      serverName: 'hub.example.org',
      version: 'solanum-1.0-dev',
      network: 'Libera.Chat',
    });
  });

  it('ignores 005 lines that have no NETWORK= token', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({
      Kind: '005', From: 'hub.example.org',
      Args: ['CHANTYPES=#&', 'CASEMAPPING=rfc1459'],
    }));
    expect(chat.getState().serverInfo).toEqual({});
  });
});

describe('ChatService NAMES self-heal (empty member list fallback)', () => {
  it('keeps re-requesting NAMES on a joined channel with an empty member list, then stops once populated', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { engine } = makeChat('me');
      engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#x' }));
      engine.namesCalls.length = 0; // ignore any request from the join itself

      // While the list stays empty, the fallback re-issues NAMES over time.
      vi.advanceTimersByTime(8000);
      const after1 = engine.namesCalls.filter((c) => c === '#x').length;
      expect(after1).toBeGreaterThanOrEqual(1);
      vi.advanceTimersByTime(6000);
      expect(engine.namesCalls.filter((c) => c === '#x').length).toBeGreaterThan(after1);

      // NAMES finally arrives → the retry is cancelled, no further requests.
      engine.emit(makeEvent({ Kind: '353', Target: '#x', Message: 'me alice' }));
      engine.emit(makeEvent({ Kind: '366', Target: '#x' }));
      const afterPopulate = engine.namesCalls.length;
      vi.advanceTimersByTime(60000);
      expect(engine.namesCalls.length).toBe(afterPopulate);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after a bounded number of retries (no infinite polling)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { engine } = makeChat('me');
      engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#y' }));
      // Never populate; run well past the retry budget.
      vi.advanceTimersByTime(120000);
      const total = engine.namesCalls.filter((c) => c === '#y').length;
      // Bounded — a handful of attempts, not unbounded polling.
      expect(total).toBeLessThanOrEqual(7);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChatService channel topics', () => {
  function getChannel(chat: ReturnType<typeof makeChat>['chat'], name: string) {
    return chat.getState().channels.find((c) => c.name === name);
  }

  it('captures topic from RPL_TOPIC (332) on join', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: '332', Target: '#general', Message: 'Welcome to general — be nice.' }));
    expect(getChannel(chat, '#general')?.topic).toBe('Welcome to general — be nice.');
  });

  it('RPL_NOTOPIC (331) clears the stored topic', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#empty' }));
    engine.emit(makeEvent({ Kind: '332', Target: '#empty', Message: 'old topic' }));
    engine.emit(makeEvent({ Kind: '331', Target: '#empty' }));
    expect(getChannel(chat, '#empty')?.topic).toBe('');
    expect(getChannel(chat, '#empty')?.topicSetBy).toBeUndefined();
  });

  it('live TOPIC change updates the topic + records setter + posts a system message', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: '332', Target: '#general', Message: 'old topic' }));
    engine.emit(makeEvent({ Kind: 'TOPIC', From: 'alice', Target: '#general', Message: 'new topic, ratified' }));
    const ch = getChannel(chat, '#general');
    expect(ch?.topic).toBe('new topic, ratified');
    expect(ch?.topicSetBy).toBe('alice');
    expect(ch?.topicSetAt).toBeGreaterThan(0);
    // Inline notice so scrollback shows who changed it.
    const lastMsg = ch?.messages[ch.messages.length - 1];
    expect(lastMsg?.kind).toBe('system');
    expect(lastMsg?.text).toMatch(/alice changed the topic to: new topic, ratified/);
  });

  it('TOPIC clear (empty message) posts a "cleared" system message', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: 'TOPIC', From: 'bob', Target: '#general', Message: '' }));
    const ch = getChannel(chat, '#general');
    expect(ch?.topic).toBe('');
    expect(ch?.topicSetBy).toBe('bob');
    const lastMsg = ch?.messages[ch.messages.length - 1];
    expect(lastMsg?.text).toMatch(/bob cleared the topic/);
  });

  it('RPL_TOPICWHOTIME (333) populates topicSetBy + topicSetAt without altering topic', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: '332', Target: '#general', Message: 'topic body' }));
    engine.emit(makeEvent({ Kind: '333', Target: '#general', Args: ['carol', '1700000000'] }));
    const ch = getChannel(chat, '#general');
    expect(ch?.topic).toBe('topic body');
    expect(ch?.topicSetBy).toBe('carol');
    expect(ch?.topicSetAt).toBe(1700000000_000);
  });

  it('333 with malformed args is a no-op (no crash, fields untouched)', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#general' }));
    engine.emit(makeEvent({ Kind: '333', Target: '#general', Args: ['carol'] }));
    expect(getChannel(chat, '#general')?.topicSetBy).toBeUndefined();
  });

  it('ignores TOPIC events with no Target', () => {
    const { chat, engine } = makeChat();
    // Should not crash, should not create a phantom channel.
    engine.emit(makeEvent({ Kind: 'TOPIC', From: 'alice', Message: 'orphan' }));
    expect(chat.getState().channels).toEqual([]);
  });
});

describe('ChatService away/online tracking', () => {
  function findMember(chat: ReturnType<typeof makeChat>['chat'], channel: string, nick: string) {
    return chat.getState().channels.find((c) => c.name === channel)?.members.find((m) => m.nick === nick);
  }

  it('AWAY event with a message marks the member as away across every shared channel', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#a', Message: 'alice me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#b' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#b', Message: 'alice me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#b' }));

    engine.emit(makeEvent({ Kind: 'AWAY', From: 'alice', Message: 'bbiab' }));
    expect(findMember(chat, '#a', 'alice')?.awayMessage).toBe('bbiab');
    expect(findMember(chat, '#b', 'alice')?.awayMessage).toBe('bbiab');
  });

  it('AWAY event with empty message clears the away flag (i.e. they came back)', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#a', Message: 'alice me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'AWAY', From: 'alice', Message: 'bbiab' }));
    expect(findMember(chat, '#a', 'alice')?.awayMessage).toBe('bbiab');

    engine.emit(makeEvent({ Kind: 'AWAY', From: 'alice', Message: '' }));
    expect(findMember(chat, '#a', 'alice')?.awayMessage).toBeNull();
  });

  it('RPL_AWAY (301) populates the awayMessage of the targeted nick', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#a', Message: 'alice me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '301', Args: ['alice'], Message: 'on lunch' }));
    expect(findMember(chat, '#a', 'alice')?.awayMessage).toBe('on lunch');
  });

  it('RPL_NOWAWAY (306) emits a system confirmation in the active channel', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    chat.setActive('#a');
    engine.emit(makeEvent({ Kind: '306', Message: 'You have been marked as being away' }));
    const ch = chat.getState().channels.find((c) => c.name === '#a')!;
    const last = ch.messages[ch.messages.length - 1];
    expect(last?.kind).toBe('system');
    expect(last?.text).toMatch(/marked as away/);
  });

  it('RPL_UNAWAY (305) emits a "no longer away" system confirmation', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    chat.setActive('#a');
    engine.emit(makeEvent({ Kind: '305', Message: 'You are no longer marked as being away' }));
    const ch = chat.getState().channels.find((c) => c.name === '#a')!;
    const last = ch.messages[ch.messages.length - 1];
    expect(last?.kind).toBe('system');
    expect(last?.text).toMatch(/no longer marked as away/);
  });

  it('/away with a message dispatches AwayParams to the engine', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    chat.setActive('#a');
    chat.input('/away bbiab');
    expect(engine.awayCalls).toEqual([{ message: 'bbiab' }]);
  });

  it('/back is a /away with no message — clears the away flag', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    chat.setActive('#a');
    chat.input('/back');
    expect(engine.awayCalls).toEqual([{ message: '' }]);
  });

  it('/nick <new> dispatches a nick change to the engine', () => {
    const { chat, engine } = makeChat('oldnick');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'oldnick', Target: '#a' }));
    chat.setActive('#a');
    chat.input('/nick newnick');
    expect(engine.nickCalls).toEqual(['newnick']);
  });

  it('/nick with no argument surfaces a usage error via feedback and dispatches nothing', () => {
    // Slash-command usage hints come out the feedback channel (transient
    // banner above the input) — they're not persisted as system
    // messages, so we listen on subscribeFeedback rather than poking
    // channel.messages.
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    chat.setActive('#a');
    const feedback: Array<{ kind: string; text?: string }> = [];
    const unsub = chat.onFeedback((f) => feedback.push(f as { kind: string; text?: string }));
    chat.input('/nick   ');
    unsub();
    expect(engine.nickCalls).toEqual([]);
    expect(feedback.find((f) => f.kind === 'error' && /Usage: \/nick/.test(f.text ?? ''))).toBeDefined();
  });

  it('changeNick() routes through the same dispatcher as the slash command', () => {
    // Exposed as a public method so the settings UI can drive a rename
    // without users typing slash syntax. Same end-state either way.
    const { chat, engine } = makeChat('me');
    chat.changeNick('newnick');
    expect(engine.nickCalls).toEqual(['newnick']);
  });

  it('incoming NICK event renames the member across every channel they were in', () => {
    // The server broadcasts a single NICK event when a user renames;
    // the renderer fans it out to every channel that user was in. This
    // test is the regression guard for that fan-out (and for the future
    // case where we might mistake NICK for a per-channel event).
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#b' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#a', Message: 'alice me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#b', Message: 'alice bob me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#b' }));
    engine.emit(makeEvent({ Kind: 'NICK', From: 'alice', Message: 'aliceeee' }));

    const a = chat.getState().channels.find((c) => c.name === '#a')!;
    const b = chat.getState().channels.find((c) => c.name === '#b')!;
    expect(a.members.some((m) => m.nick === 'aliceeee')).toBe(true);
    expect(a.members.some((m) => m.nick === 'alice')).toBe(false);
    expect(b.members.some((m) => m.nick === 'aliceeee')).toBe(true);
    expect(b.members.some((m) => m.nick === 'alice')).toBe(false);
  });

  it('RPL_WHOREPLY (352) with G status flag marks the named member as away', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#a', Message: 'alice bob me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '352', Target: '#a', From: 'alice', Args: ['G@'] }));
    engine.emit(makeEvent({ Kind: '352', Target: '#a', From: 'bob',   Args: ['H'] }));
    const ch = chat.getState().channels.find((c) => c.name === '#a')!;
    expect(ch.members.find((m) => m.nick === 'alice')?.awayMessage).toBe('');
    expect(ch.members.find((m) => m.nick === 'bob')?.awayMessage).toBeFalsy();
  });

  it('RPL_WHOREPLY (352) preserves any awayMessage already set by AWAY push', () => {
    // If we get an AWAY push for the user first (after-join state change),
    // a subsequent WHO for an unrelated channel must not erase the
    // already-known reason. We keep the existing string when WHO confirms
    // away-state but doesn't carry the reason itself.
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#a', Message: 'alice me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'AWAY', From: 'alice', Message: 'gone to lunch' }));
    engine.emit(makeEvent({ Kind: '352', Target: '#a', From: 'alice', Args: ['G@'] }));
    const ch = chat.getState().channels.find((c) => c.name === '#a')!;
    expect(ch.members.find((m) => m.nick === 'alice')?.awayMessage).toBe('gone to lunch');
  });

  it('RPL_WHOREPLY (352) for an unknown channel is a no-op', () => {
    const { chat, engine } = makeChat();
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: '353', Target: '#a', Message: 'alice me' }));
    engine.emit(makeEvent({ Kind: '366', Target: '#a' }));
    // Channel we never joined — must not throw or create a stray channel.
    engine.emit(makeEvent({ Kind: '352', Target: '#nope', From: 'alice', Args: ['G'] }));
    const state = chat.getState();
    expect(state.channels.find((c) => c.name === '#nope')).toBeUndefined();
    expect(state.channels.find((c) => c.name === '#a')!.members.find((m) => m.nick === 'alice')?.awayMessage).toBeFalsy();
  });
});

describe('ChatService identity (host + account) population', () => {
  const member = (chat: ChatService, chan: string, nick: string) =>
    chat.getState().channels.find((c) => c.name === chan)?.members.find((m) => m.nick === nick);

  it('populates member hostname + account from an extended-join', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'alice', Target: '#a', Host: 'user/alice', Account: 'aliceacct' }));
    expect(member(chat, '#a', 'alice')).toMatchObject({ hostname: 'user/alice', account: 'aliceacct' });
  });

  it('captures our OWN host + account from the self-join (extended-join echo)', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a', Host: 'cloak/me', Account: 'myacct' }));
    expect(chat.selfIdentity()).toMatchObject({ nick: 'me', host: 'cloak/me', account: 'myacct' });
  });

  it('ACCOUNT updates a member account live; logout (empty) clears it', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'bob', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'ACCOUNT', From: 'bob', Account: 'bobacct' }));
    expect(member(chat, '#a', 'bob')?.account).toBe('bobacct');
    engine.emit(makeEvent({ Kind: 'ACCOUNT', From: 'bob', Account: '' }));
    expect(member(chat, '#a', 'bob')?.account).toBeUndefined();
  });

  it('CHGHOST updates a member hostname live', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'bob', Target: '#a', Host: 'old/host' }));
    engine.emit(makeEvent({ Kind: 'CHGHOST', From: 'bob', Host: 'new/host' }));
    expect(member(chat, '#a', 'bob')?.hostname).toBe('new/host');
  });

  it('refreshes a member account from the account-tag on a channel message', () => {
    const { chat, engine } = makeChat('me');
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'me', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'JOIN', From: 'bob', Target: '#a' }));
    engine.emit(makeEvent({ Kind: 'PRIVMSG', From: 'bob', Target: '#a', Message: 'hi', Account: 'bobacct' }));
    expect(member(chat, '#a', 'bob')?.account).toBe('bobacct');
  });
});
