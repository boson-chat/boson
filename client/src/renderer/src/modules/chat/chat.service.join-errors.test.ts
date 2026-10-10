import { describe, it, expect } from 'vitest';
import { ChatService, type ChatFeedback } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

// Fake engine session: records nothing, just lets the test push events.
function makeService(): { chat: ChatService; emit: (e: Partial<IrcEvent> & { Kind: string }) => void; feedback: ChatFeedback[] } {
  let listener: EventListener | null = null;
  const session = {
    serverId: 'srv-test',
    join: () => {}, part: () => {}, privmsg: () => {}, names: () => {}, tagmsg: () => {},
    list: () => {}, away: () => {}, nick: () => {}, nickservIdentify: () => {}, raw: () => {},
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
  } as unknown as ServerSession;
  const chat = new ChatService(session, 'me');
  chat.attach();
  const feedback: ChatFeedback[] = [];
  chat.onFeedback((f) => feedback.push(f));
  const emit = (e: Partial<IrcEvent> & { Kind: string }): void =>
    listener?.({ From: '', Target: '', Message: '', Raw: '', ...e } as IrcEvent);
  return { chat, emit, feedback };
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
