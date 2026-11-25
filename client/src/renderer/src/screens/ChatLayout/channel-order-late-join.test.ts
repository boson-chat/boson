// A channel that joins late (refused with 477 until NickServ identified us,
// then joined) keeps its place in the channel list: the default order is the
// saved channel list's, and a saved custom order isn't disturbed.
import { describe, expect, it } from 'vitest';
import { ChatService } from '../../modules/chat/chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../../modules/engine';
import { ChannelSidebarBloc } from './ChannelSidebarBloc';

function makeService(): { chat: ChatService; emit: (e: Partial<IrcEvent> & { Kind: string }) => void } {
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
  const chat = new ChatService(session, 'me', undefined);
  chat.attach();
  const emit = (e: Partial<IrcEvent> & { Kind: string }): void =>
    listener?.({ From: '', Target: '', Message: '', Raw: '', ...e } as IrcEvent);
  return { chat, emit };
}

// Reconnect restore: join the saved channels; #members (registered users
// only) is refused until NickServ has identified us, then joins.
function lateJoin(): ChatService {
  const { chat, emit } = makeService();
  for (const c of ['#members', '#dev', '#ops']) chat.join(c, { focus: false });
  emit({ Kind: '477', Target: 'me', Message: 'You need to be identified', Args: ['#members', 'x'] });
  emit({ Kind: 'JOIN', From: 'me', Target: '#dev' });
  emit({ Kind: 'JOIN', From: 'me', Target: '#ops' });
  // …identified: the retry gets in.
  chat.join('#members', { focus: false });
  emit({ Kind: 'JOIN', From: 'me', Target: '#members' });
  return chat;
}

const sidebar = (chat: ChatService, order?: string[], defaults?: string[]) => new ChannelSidebarBloc({
  getChannels: () => chat.getState().channels,
  getOrder: () => order,
  getDefaultOrder: () => defaults,
  onJoin: () => {},
}).getState();

describe('a channel that joins late keeps its place', () => {
  it('the join order alone puts it last (what the list used to show)', () => {
    expect(sidebar(lateJoin()).realChannels.map((c) => c.name)).toEqual(['#dev', '#ops', '#members']);
  });

  it('in the default order: the saved channel list', () => {
    const s = sidebar(lateJoin(), undefined, ['#members', '#dev', '#ops']);
    expect(s.realChannels.map((c) => c.name)).toEqual(['#members', '#dev', '#ops']);
    expect(s.customOrder).toBe(false);
  });

  it('in a custom order', () => {
    const s = sidebar(lateJoin(), ['#ops', '#members', '#dev'], ['#members', '#dev', '#ops']);
    expect(s.realChannels.map((c) => c.name)).toEqual(['#ops', '#members', '#dev']);
    expect(s.customOrder).toBe(true);
  });

  it('a custom order equal to the default one is not custom', () => {
    expect(sidebar(lateJoin(), ['#members', '#dev', '#ops'], ['#members', '#dev', '#ops']).customOrder).toBe(false);
  });
});
