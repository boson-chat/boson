import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

// A bouncer attach replays WHO for every joined channel — tens of thousands
// of 352 lines, read off the socket as fast as the bouncer sends them. A
// version that redid the whole channel's member list on every line stalled
// the app long enough on a big channel that the bouncer (evrd, soju) dropped
// the connection for not reading, and the app reconnected in a loop. Each
// line must stay cheap: here a 5,000-member channel's whole WHO.

const MEMBERS = 5_000;
// The per-line full pass took over 2s here; the per-member update ~150ms.
// The budget leaves a slower CI machine 5x headroom.
const BUDGET_MS = 750;

function makeChat() {
  let listener: EventListener | null = null;
  const session = {
    serverId: 'srv-test',
    join: () => {}, part: () => {}, privmsg: () => {},
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: () => {},
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
  };
  const chat = new ChatService(session as unknown as ServerSession, 'me');
  chat.attach();
  const emit = (e: Partial<IrcEvent>): void => listener?.({ Kind: '', From: '', Target: '', Message: '', Raw: '', ...e });
  return { chat, emit };
}

describe('ChatService — a big channel\'s WHO flood', () => {
  it(`takes a ${MEMBERS}-member WHO in under ${BUDGET_MS}ms, and applies it`, () => {
    const { chat, emit } = makeChat();
    const nicks = Array.from({ length: MEMBERS }, (_, i) => `user${i}`);
    emit({ Kind: 'JOIN', From: 'me', Target: '#big' });
    for (let i = 0; i < nicks.length; i += 400) {
      emit({ Kind: '353', Target: '#big', Message: nicks.slice(i, i + 400).join(' ') });
    }
    emit({ Kind: '366', Target: '#big' });

    const start = performance.now();
    for (const [i, nick] of nicks.entries()) {
      emit({
        Kind: '352', Target: '#big', From: nick, User: `~${nick}`, Host: `host${i}.example`,
        Args: [i % 3 === 0 ? 'G' : 'H', 'irc.example.net'], Message: `0 Real ${nick}`,
      });
    }
    emit({ Kind: '315', Target: '#big' });
    const took = performance.now() - start;

    expect(took).toBeLessThan(BUDGET_MS);
    const members = chat.getState().channels.find((c) => c.name === '#big')!.members;
    expect(members).toHaveLength(MEMBERS);
    expect(members[0]).toMatchObject({ user: '~user0', hostname: 'host0.example', awayMessage: '', realname: 'Real user0' });
    expect(members[MEMBERS - 1]).toMatchObject({ hostname: `host${MEMBERS - 1}.example`, server: 'irc.example.net' });
  });
});
