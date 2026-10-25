import { describe, it, expect, vi } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

// What ChatService learns about other users for their profiles: the mask,
// realname, server and oper/bot flags from WHO, JOIN, CHGHOST and SETNAME,
// and a WHOIS on demand.

function makeChat() {
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
  const chat = new ChatService(session as unknown as ServerSession, 'me');
  chat.attach();
  const emit = (e: Partial<IrcEvent>): void => listener?.({ Kind: '', From: '', Target: '', Message: '', Raw: '', ...e });
  const member = (nick: string) => chat.getState().channels.find((c) => c.name === '#general')!.members.find((m) => m.nick === nick);
  const join = (): void => {
    emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    emit({ Kind: '353', Target: '#general', Message: '@bob carol' });
    emit({ Kind: '366', Target: '#general' });
  };
  return { chat, emit, member, join, raw };
}

describe('ChatService — member details', () => {
  it('takes the mask, server, realname and flags from WHO', () => {
    const { emit, member, join } = makeChat();
    join();
    emit({ Kind: '352', Target: '#general', From: 'bob', User: '~bob', Host: 'user/bob', Args: ['H*@', 'irc.example.net'], Message: '0 Bob Builder' });
    emit({ Kind: '352', Target: '#general', From: 'carol', User: 'carol', Host: '10.0.0.1', Args: ['GB', 'leaf.example.net'], Message: '2 Carol' });
    expect(member('bob')).toMatchObject({
      user: '~bob', hostname: 'user/bob', server: 'irc.example.net', realname: 'Bob Builder', oper: true, awayMessage: null,
    });
    expect(member('bob')!.bot).toBeUndefined();
    expect(member('carol')).toMatchObject({ bot: true, awayMessage: '', realname: 'Carol' });
    expect(member('carol')!.oper).toBeUndefined();
  });

  it('holds WHO lines that beat the member list, then applies them', () => {
    const { emit, member } = makeChat();
    emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    emit({ Kind: '352', Target: '#general', From: 'bob', User: 'b', Host: 'h', Args: ['H', 'irc.x'], Message: '0 Bob' });
    emit({ Kind: '353', Target: '#general', Message: 'bob' });
    emit({ Kind: '366', Target: '#general' });
    expect(member('bob')).toMatchObject({ user: 'b', hostname: 'h', server: 'irc.x', realname: 'Bob' });
  });

  it('a joiner brings their mask and (extended-join) realname', () => {
    const { emit, member, join } = makeChat();
    join();
    emit({ Kind: 'JOIN', From: 'dave', Target: '#general', User: 'dave', Host: 'dave.example', Account: 'davea', Message: 'Dave Lister' });
    expect(member('dave')).toMatchObject({ user: 'dave', hostname: 'dave.example', account: 'davea', realname: 'Dave Lister' });
  });

  it('follows CHGHOST and SETNAME', () => {
    const { emit, member, join } = makeChat();
    join();
    emit({ Kind: 'CHGHOST', From: 'bob', User: 'newbob', Host: 'cloak/bob', Args: ['newbob', 'cloak/bob'] });
    emit({ Kind: 'SETNAME', From: 'bob', Message: 'Robert' });
    expect(member('bob')).toMatchObject({ user: 'newbob', hostname: 'cloak/bob', realname: 'Robert' });
  });
});

describe('ChatService — WHOIS for profiles', () => {
  it('sends one WHOIS and builds the profile from the replies', () => {
    const { chat, emit, raw } = makeChat();
    chat.requestWhois('Bob');
    chat.requestWhois('bob'); // still out: not sent again
    expect(raw).toEqual(['WHOIS Bob']);
    expect(chat.whois.value.get('bob')).toMatchObject({ nick: 'Bob', loading: true });

    emit({ Kind: '311', Args: ['Bob', '~bob', 'user/bob', '*', 'Bob Builder'], Message: 'Bob Builder' });
    emit({ Kind: '319', Args: ['Bob', '@#ops #general'], Message: '@#ops #general' });
    emit({ Kind: '312', Args: ['Bob', 'irc.example.net', 'Example, EU'], Message: 'Example, EU' });
    emit({ Kind: '301', Args: ['Bob'], Message: 'lunch' });
    emit({ Kind: '671', Args: ['Bob', 'is using a secure connection'], Message: 'is using a secure connection' });
    emit({ Kind: '317', Args: ['Bob', '125', '1700000000', 'seconds idle, signon time'], Message: 'seconds idle, signon time' });
    emit({ Kind: '330', Args: ['Bob', 'bobacct', 'is logged in as'], Message: 'is logged in as' });
    emit({ Kind: '318', Args: ['Bob', 'End of /WHOIS list.'], Message: 'End of /WHOIS list.' });

    expect(chat.whois.value.get('bob')).toMatchObject({
      user: '~bob', host: 'user/bob', realname: 'Bob Builder',
      channels: ['@#ops', '#general'], server: 'irc.example.net', serverInfo: 'Example, EU',
      away: 'lunch', secure: true, idleSeconds: 125, signonAt: 1_700_000_000_000,
      account: 'bobacct', loading: false,
    });
    chat.requestWhois('bob'); // fresh: reused
    expect(raw).toHaveLength(1);
  });

  it('marks a nick that has gone', () => {
    const { chat, emit } = makeChat();
    chat.requestWhois('ghost');
    emit({ Kind: '401', Args: ['ghost', 'No such nick/channel'], Message: 'No such nick/channel' });
    expect(chat.whois.value.get('ghost')).toMatchObject({ notFound: true, loading: false });
  });

  it('ignores an away reply or 401 that is not for a WHOIS', () => {
    const { chat, emit } = makeChat();
    emit({ Kind: '301', Args: ['bob'], Message: 'lunch' });
    emit({ Kind: '401', Args: ['ghost'], Message: 'No such nick/channel' });
    expect(chat.whois.value.size).toBe(0);
  });

  it('a /whois typed by hand fills the profile too', () => {
    const { chat, emit } = makeChat();
    emit({ Kind: '311', Args: ['carol', 'c', 'carol.host', '*', 'Carol'], Message: 'Carol' });
    expect(chat.whois.value.get('carol')).toMatchObject({ user: 'c', host: 'carol.host', realname: 'Carol' });
  });
});

describe('ChatService — restoring the last channel', () => {
  it('shows the saved channel once it joins, not the first to join', () => {
    const { chat, emit } = makeChat();
    chat.restoreActiveChannel('#boson');
    emit({ Kind: 'JOIN', From: 'me', Target: '#ai' });
    expect(chat.getState().activeChannel).toBeNull();
    emit({ Kind: 'JOIN', From: 'me', Target: '#boson' });
    expect(chat.getState().activeChannel).toBe('#boson');
  });

  it('falls back to the first joined channel when the saved one never joins', () => {
    vi.useFakeTimers();
    try {
      const { chat, emit } = makeChat();
      chat.restoreActiveChannel('#gone');
      emit({ Kind: 'JOIN', From: 'me', Target: '#ai' });
      emit({ Kind: 'JOIN', From: 'me', Target: '#boson' });
      vi.advanceTimersByTime(4_000);
      expect(chat.getState().activeChannel).toBe('#ai');
      // A late join of the saved channel no longer steals the view.
      emit({ Kind: 'JOIN', From: 'me', Target: '#gone' });
      expect(chat.getState().activeChannel).toBe('#ai');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pick before the saved channel joins wins', () => {
    const { chat, emit } = makeChat();
    chat.restoreActiveChannel('#boson');
    emit({ Kind: 'JOIN', From: 'me', Target: '#ai' });
    chat.setActive('#ai');
    emit({ Kind: 'JOIN', From: 'me', Target: '#boson' });
    expect(chat.getState().activeChannel).toBe('#ai');
  });

  it('ignores a saved conversation (not a channel)', () => {
    const { chat, emit } = makeChat();
    chat.restoreActiveChannel('bob');
    emit({ Kind: 'JOIN', From: 'me', Target: '#ai' });
    expect(chat.getState().activeChannel).toBe('#ai');
  });
});
