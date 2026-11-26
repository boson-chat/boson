import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { ChatLayout } from './ChatLayout';
import { setFriendsUi } from '../Friends/friends-ui';
import type { ChatService, ChatState } from '../../modules/chat';

// "Switching to myself and then to a server shows the join or create a
// channel popup when I didn't trigger it": your avatar on the rail, Calls,
// then any server tile, and the server opens on its channel with "Join or
// create a channel" on top.
//
// The empty-server welcome's "Browse all channels" asked the channel list
// to open its browser by bumping a counter in the layout, which outlives
// server switches. MY (Friends / Calls / DMs) replaces the channel list, so
// coming back from it mounts a fresh list, which saw the counter still
// above zero and opened the browser again: on every return from MY, on any
// server, for the rest of the session after one Browse.

function viewport(narrow: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: narrow, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

const lobby = { name: '#lobby', joined: true, members: [{ nick: 'me', prefix: '' }], messages: [], typing: [], unread: 0, mentions: 0, topic: '' };
function stateWith(channels: unknown[], active: string | null): ChatState {
  return {
    channels, activeChannel: active, serverLog: [], serverInfo: {},
    channelDirectory: { status: 'idle', entries: [], updatedAt: null }, myNick: 'me', myOper: false, servicesFramework: null,
  } as unknown as ChatState;
}
function fakeChat(state: ChatState): ChatService {
  return {
    getState: vi.fn(() => state),
    subscribe: vi.fn((cb: (s: ChatState) => void) => { cb(state); return () => {}; }),
    onFeedback: vi.fn(() => () => {}),
    join: vi.fn(), part: vi.fn(), send: vi.fn(), input: vi.fn(), setActive: vi.fn(), attach: vi.fn(), detach: vi.fn(),
    setNick: vi.fn(), clearServerLog: vi.fn(), sendTyping: vi.fn(), rejoin: vi.fn(),
  } as unknown as ChatService;
}
// Nebula: connected, in no channel yet (the welcome). Pulsar: on #lobby.
const chats: Record<string, ChatService> = {
  s1: fakeChat(stateWith([], null)),
  s2: fakeChat(stateWith([lobby], '#lobby')),
};
const names: Record<string, string> = { s1: 'Nebula', s2: 'Pulsar' };
const tiles = [
  { serverId: 's1', name: 'Nebula', engineState: 'connected' },
  { serverId: 's2', name: 'Pulsar', engineState: 'connected' },
] as never;

// Like DirectoryScreen: one ChatLayout, its chat swapped on a server switch.
function app(start = 's1') {
  let rerender: (ui: preact.ComponentChild) => void = () => {};
  const view = (id: string) => (
    <ChatLayout chat={chats[id]} serverName={names[id]} myNick="me" engineState="connected"
      servers={tiles} activeServerId={id} onSelectServer={(next) => rerender(view(next))} onBrowseServers={() => {}} />
  );
  ({ rerender } = render(view(start)));
}

// The modal stays in the tree for its exit transition: open is the
// is-open backdrop, once the timers settle.
function joinDialogOpen(): boolean {
  act(() => { vi.runAllTimers(); });
  const d = screen.queryByRole('dialog', { name: /join (or create )?a channel/i });
  return !!d && !!d.closest('.bds-modal-backdrop.is-open');
}
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const toMy = () => click(/^You: friends, calls and messages/);
const tile = (name: string) => fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`^${name}`) })
  .find((b) => b.closest('.server-rail'))!);

beforeEach(() => {
  vi.useFakeTimers();
  viewport(false);
  setFriendsUi({ phone: null, my: false, myView: 'friends' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setFriendsUi({ phone: null, my: false, myView: 'friends' });
});

describe('the join dialog only opens when asked', () => {
  it('opens from the welcome\'s Browse', () => {
    app();
    expect(joinDialogOpen()).toBe(false);
    click('Browse all channels');
    expect(joinDialogOpen()).toBe(true);
  });

  it('you, Calls, then a server tile: no join dialog (after one Browse earlier)', () => {
    app();
    // Earlier in the session: Browse on the empty server, then closed.
    click('Browse all channels');
    expect(joinDialogOpen()).toBe(true);
    click('Cancel');
    expect(joinDialogOpen()).toBe(false);
    tile('Pulsar');
    expect(joinDialogOpen()).toBe(false);

    // The repro: your avatar, Calls, then any server tile.
    toMy();
    click(/^Calls/);
    expect(screen.getByRole('main', { name: 'Calls' })).toBeTruthy();
    tile('Pulsar');
    expect(screen.queryByRole('main', { name: 'Calls' })).toBeNull();
    expect(joinDialogOpen()).toBe(false);

    // Again, to the other server, and via Friends.
    toMy();
    click(/^Calls/);
    tile('Nebula');
    expect(joinDialogOpen()).toBe(false);
    toMy();
    click(/^Friends/);
    tile('Pulsar');
    expect(joinDialogOpen()).toBe(false);
  });

  it('Browse still opens it after a trip to MY', () => {
    app();
    click('Browse all channels');
    click('Cancel');
    toMy();
    click(/^Calls/);
    tile('Nebula');
    expect(joinDialogOpen()).toBe(false);
    click('Browse all channels');
    expect(joinDialogOpen()).toBe(true);
  });

  it('you, Calls, then a server tile with no Browse at all: no join dialog', () => {
    app('s2');
    toMy();
    click(/^Calls/);
    tile('Pulsar');
    expect(joinDialogOpen()).toBe(false);
  });
});
