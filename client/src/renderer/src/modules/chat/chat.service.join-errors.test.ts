import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatService, isOperatorOnlyCreation, joinRefusalText, type ChatFeedback } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

// Fake engine session: records nothing, just lets the test push events.
function makeService(server?: { serverId: string; serverName?: string }): { chat: ChatService; emit: (e: Partial<IrcEvent> & { Kind: string }) => void; feedback: ChatFeedback[]; joins: string[] } {
  let listener: EventListener | null = null;
  const joins: string[] = [];
  const session = {
    serverId: 'srv-test',
    join: (c: string) => { joins.push(c); }, part: () => {}, privmsg: () => {}, names: () => {}, tagmsg: () => {},
    list: () => {}, away: () => {}, nick: () => {}, nickservIdentify: () => {}, raw: () => {},
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
  } as unknown as ServerSession;
  const chat = new ChatService(session, 'me', undefined, server ? { server } : undefined);
  chat.attach();
  const feedback: ChatFeedback[] = [];
  chat.onFeedback((f) => feedback.push(f));
  const emit = (e: Partial<IrcEvent> & { Kind: string }): void =>
    listener?.({ From: '', Target: '', Message: '', Raw: '', ...e } as IrcEvent);
  return { chat, emit, feedback, joins };
}

describe('ChatService — a refused /join', () => {
  for (const [numeric, reason] of [
    ['471', 'Cannot join channel (+l)'],
    ['473', 'Cannot join channel (+i)'],
    ['474', 'Cannot join channel (+b)'],
    ['475', 'Cannot join channel (+k)'],
  ] as const) {
    it(`${numeric}: drops the optimistic channel and reports why`, () => {
      const { chat, emit, feedback } = makeService();
      chat.join('#home');
      emit({ Kind: 'JOIN', From: 'me', Target: '#home' });
      chat.join('#Locked');
      expect(chat.getState().activeChannel).toBe('#locked');

      emit({ Kind: numeric, Target: 'me', Message: reason, Args: ['#Locked', reason] });

      const state = chat.getState();
      expect(state.channels.map((c) => c.name)).toEqual(['#home']);
      expect(state.activeChannel).toBe('#home');
      expect(feedback).toEqual([{ kind: 'error', text: `Cannot join #Locked: ${reason}` }]);
    });
  }

  it('leaves a channel we are already in alone (e.g. a stale 474 on rejoin)', () => {
    const { chat, emit } = makeService();
    chat.join('#home');
    emit({ Kind: 'JOIN', From: 'me', Target: '#home' });
    emit({ Kind: '474', Target: 'me', Message: 'banned', Args: ['#home', 'banned'] });
    expect(chat.getState().channels.map((c) => c.name)).toEqual(['#home']);
  });
});

describe('ChatService — leaving the last channel', () => {
  it('never falls back to the hidden ~server log', () => {
    const { chat, emit } = makeService();
    // A service notice creates the ~server pseudo-channel first.
    emit({ Kind: 'NOTICE', From: 'NickServ', Target: 'me', Message: 'Unknown command.' });
    chat.join('#only');
    emit({ Kind: 'JOIN', From: 'me', Target: '#only' });
    expect(chat.getState().activeChannel).toBe('#only');

    emit({ Kind: 'KICK', From: 'op', Target: '#only', Args: ['me'], Message: 'bye' });
    expect(chat.getState().activeChannel).toBeNull();

    chat.join('#again');
    emit({ Kind: 'JOIN', From: 'me', Target: '#again' });
    chat.part('#again');
    expect(chat.getState().activeChannel).toBeNull();
  });

  it('falls back to another visible conversation when there is one', () => {
    const { chat, emit } = makeService();
    emit({ Kind: 'NOTICE', From: 'NickServ', Target: 'me', Message: 'hi' });
    chat.join('#a');
    emit({ Kind: 'JOIN', From: 'me', Target: '#a' });
    chat.join('#b');
    emit({ Kind: 'JOIN', From: 'me', Target: '#b' });
    chat.part('#b');
    expect(chat.getState().activeChannel).toBe('#a');
  });
});

describe('ChatService — bouncer detection', () => {
  it('does not mistake a plain IRCd advertising znc.in/self-message for ZNC', () => {
    const { chat, emit } = makeService();
    emit({ Kind: 'CAP', Message: 'userhost-in-names znc.in/self-message', Args: ['LS'] });
    expect(chat.getState().serverInfo.bouncer).toBeFalsy();
  });

  it('still detects ZNC from its other vendor caps', () => {
    const { chat, emit } = makeService();
    emit({ Kind: 'CAP', Message: 'znc.in/self-message znc.in/playback', Args: ['LS'] });
    expect(chat.getState().serverInfo.bouncer).toBe(true);
  });
});

describe('ChatService.rejoin — picking a channel we are not in', () => {
  afterEach(() => { vi.useRealTimers(); });
  const status = (chat: ChatService, name: string) => chat.getState().channels.find((c) => c.name === name)?.joinStatus;

  it('asks again, shows joining, and clears it when the JOIN lands', () => {
    const { chat, emit, joins } = makeService();
    chat.join('#stuck');
    joins.length = 0;
    chat.rejoin('#stuck');
    chat.rejoin('#stuck'); // already on its way: not sent twice
    expect(joins).toEqual(['#stuck']);
    expect(status(chat, '#stuck')).toEqual({ state: 'joining' });
    emit({ Kind: 'JOIN', From: 'me', Target: '#stuck' });
    expect(status(chat, '#stuck')).toBeUndefined();
    chat.rejoin('#stuck'); // joined now: nothing to do
    expect(joins).toEqual(['#stuck']);
  });

  it('a refusal keeps the channel listed, with the reason; trying again works', () => {
    const { chat, emit, joins } = makeService();
    chat.join('#members');
    chat.rejoin('#members');
    emit({ Kind: '477', Target: 'me', Message: 'You need to be logged into an account to join', Args: ['#members', 'x'] });
    expect(chat.getState().channels.map((c) => c.name)).toContain('#members');
    expect(status(chat, '#members')).toEqual({ state: 'failed', error: 'You need to be logged into an account to join' });
    joins.length = 0;
    chat.rejoin('#members');
    expect(joins).toEqual(['#members']);
    expect(status(chat, '#members')).toEqual({ state: 'joining' });
  });

  it('no answer: says so after a while', () => {
    vi.useFakeTimers();
    const { chat } = makeService();
    chat.join('#quiet');
    chat.rejoin('#quiet');
    vi.advanceTimersByTime(15_000);
    expect(status(chat, '#quiet')).toEqual({ state: 'failed', error: 'No answer from the server' });
  });

  it('a 403 for something other than a pending join leaves a joined channel alone', () => {
    const { chat, emit } = makeService();
    chat.join('#home');
    emit({ Kind: 'JOIN', From: 'me', Target: '#home' });
    emit({ Kind: '403', Target: 'me', Message: 'No such channel', Args: ['#home', 'No such channel'] });
    expect(chat.getState().channels.map((c) => c.name)).toEqual(['#home']);
  });
});

// Ergo with channels.operator-only-creation (auth channel_creation: admins).
const OPER_ONLY = 'Only server operators can create new channels';

describe('ChatService — admins-only channel creation', () => {
  it('recognises Ergo\'s operator-only-creation refusal', () => {
    expect(isOperatorOnlyCreation('403', OPER_ONLY)).toBe(true);
    expect(isOperatorOnlyCreation('403', 'No such channel')).toBe(false);
    expect(isOperatorOnlyCreation('474', OPER_ONLY)).toBe(false);
    expect(joinRefusalText('#x', '403', OPER_ONLY, 'Boson')).toBe("#x doesn't exist, and only admins can create channels on Boson.");
    expect(joinRefusalText('#x', '403', OPER_ONLY, '')).toBe("#x doesn't exist, and only admins can create channels on this network.");
    expect(joinRefusalText('#x', '474', 'banned', 'Boson')).toBeNull();
  });

  it('says the channel does not exist and who can create it, naming the network', () => {
    const { chat, emit, feedback } = makeService({ serverId: 'srv-test', serverName: 'Boson' });
    chat.join('#home');
    emit({ Kind: 'JOIN', From: 'me', Target: '#home' });
    chat.join('#brandnew', { byUser: true });
    emit({ Kind: '403', Target: 'me', Message: OPER_ONLY, Args: ['#brandnew', OPER_ONLY] });
    expect(chat.getState().channels.map((c) => c.name)).toEqual(['#home']);
    expect(feedback).toEqual([{ kind: 'error', text: "#brandnew doesn't exist, and only admins can create channels on Boson." }]);
  });

  it('falls back to NETWORK= for the name', () => {
    const { chat, emit, feedback } = makeService();
    emit({ Kind: '005', Target: 'me', Message: 'are supported', Args: ['me', 'NETWORK=ExampleNet', 'are supported by this server'] });
    chat.join('#nope');
    emit({ Kind: '403', Target: 'me', Message: OPER_ONLY, Args: ['#nope', OPER_ONLY] });
    expect(feedback.at(-1)).toEqual({ kind: 'error', text: "#nope doesn't exist, and only admins can create channels on ExampleNet." });
  });

  it('puts the friendly text on a listed channel\'s retry too', () => {
    const { chat, emit } = makeService({ serverId: 'srv-test', serverName: 'Boson' });
    chat.join('#gone');
    chat.rejoin('#gone');
    emit({ Kind: '403', Target: 'me', Message: OPER_ONLY, Args: ['#gone', OPER_ONLY] });
    expect(chat.getState().channels.find((c) => c.name === '#gone')?.joinStatus)
      .toEqual({ state: 'failed', error: "#gone doesn't exist, and only admins can create channels on Boson." });
  });
});

describe('ChatService — quiet joins (a network\'s default channels)', () => {
  it('drops a refused quiet join without telling the user', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { chat, emit, feedback, joins } = makeService();
    chat.join('#home');
    emit({ Kind: 'JOIN', From: 'me', Target: '#home' });
    chat.join('#lobby', { focus: false, quiet: true });
    expect(joins).toEqual(['#home', '#lobby']);
    expect(chat.getState().activeChannel).toBe('#home');
    emit({ Kind: '403', Target: 'me', Message: OPER_ONLY, Args: ['#lobby', OPER_ONLY] });
    expect(chat.getState().channels.map((c) => c.name)).toEqual(['#home']);
    expect(feedback).toEqual([]);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('a quiet join that lands is an ordinary channel; a later refusal is reported again', () => {
    const { chat, emit, feedback } = makeService();
    chat.join('#lobby', { quiet: true });
    emit({ Kind: 'JOIN', From: 'me', Target: '#lobby' });
    expect(chat.getState().channels.find((c) => c.name === '#lobby')?.joined).toBe(true);
    chat.join('#locked', { quiet: true });
    chat.join('#locked', { byUser: true }); // the user asked for it after all
    emit({ Kind: '474', Target: 'me', Message: 'banned', Args: ['#locked', 'banned'] });
    expect(feedback).toEqual([{ kind: 'error', text: 'Cannot join #locked: banned' }]);
  });
});
