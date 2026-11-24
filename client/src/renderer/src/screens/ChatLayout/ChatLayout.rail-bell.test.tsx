import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import { ChatLayout } from './ChatLayout';
import { TitleBar } from '../TitleBar/TitleBar';
import { MySidebar } from '../Friends/MySpace';
import { setFriendsUi } from '../Friends/friends-ui';
import { setNotificationsOpener } from '../../modules/ui/open-notifications';
import { onOpenUserSettings } from '../../modules/ui/open-settings';
import { getMemoStore, type Memo } from '../../modules/memos';
import type { ChatChannel, ChatService, ChatState } from '../../modules/chat';

// Phones have no top bar (design B, "Bell joins the rail, under you"): the
// bell is in the server rail under your avatar, settings are in My space,
// and the server header is the first thing on the channel list. Narrow
// desktop windows and tablets keep the title bar.

type W = { bosonPlatform?: string; bosonShell?: string };
const w = window as unknown as W;

function viewport(narrow: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: narrow, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

const channel = {
  name: '#general', joined: true, members: [{ nick: 'me', prefix: '' }],
  messages: [], typing: [], unread: 0, mentions: 0, topic: '',
} as unknown as ChatChannel;
const state = {
  channels: [channel], activeChannel: '#general', serverLog: [], serverInfo: {},
  channelDirectory: { status: 'idle', entries: [], updatedAt: null }, myNick: 'me', myOper: false, servicesFramework: null,
} as unknown as ChatState;
function fakeChat(): ChatService {
  return {
    getState: vi.fn(() => state),
    subscribe: vi.fn((cb: (s: ChatState) => void) => { cb(state); return () => {}; }),
    onFeedback: vi.fn(() => () => {}),
    join: vi.fn(), part: vi.fn(), send: vi.fn(), input: vi.fn(), setActive: vi.fn(), attach: vi.fn(), detach: vi.fn(),
    setNick: vi.fn(), clearServerLog: vi.fn(), sendTyping: vi.fn(),
  } as unknown as ChatService;
}
const layout = () => render(<ChatLayout chat={fakeChat()} serverName="Nebula" myNick="me" onBrowseServers={() => {}} />);
// A first launch opens onto the last channel; back shows the channel list.
function toList(): void {
  const back = screen.queryByRole('button', { name: 'Back to channels' });
  if (back) fireEvent.click(back);
}

function unreadMemos(n: number): void {
  for (let i = 0; i < n; i++) {
    getMemoStore().append({ id: `rb${i}`, serverId: 's1', serverName: 'Nebula', sender: 'kestrel', kind: 'dm', read: false,
      text: 'hi', timestamp: Date.now() - i * 1000 } as Memo);
  }
}

let saved: W;
beforeEach(() => {
  saved = { bosonPlatform: w.bosonPlatform, bosonShell: w.bosonShell };
  getMemoStore().setUserId('rail-bell-test');
  setFriendsUi({ phone: null, my: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  w.bosonPlatform = saved.bosonPlatform;
  w.bosonShell = saved.bosonShell;
  setNotificationsOpener(null);
  getMemoStore().markAllRead();
  for (const m of getMemoStore().list()) getMemoStore().remove(m.id);
  setFriendsUi({ phone: null, my: false });
});

describe('the top bar on phones', () => {
  for (const [name, set] of [['the iOS app', () => { w.bosonPlatform = 'ios'; }], ['the Android app', () => { w.bosonPlatform = 'android'; }], ['the web build', () => { w.bosonShell = 'web'; }]] as const) {
    it(`is gone in ${name} at phone width`, () => {
      set();
      viewport(true);
      const { container } = render(<TitleBar onOpenSettings={() => {}} onOpenNotifications={() => {}} userLabel="ada" />);
      expect(container.querySelector('.title-bar')).toBeNull();
      expect(screen.queryByRole('button', { name: 'User settings' })).toBeNull();
    });
  }

  it('stays in a narrow desktop window (it holds the window controls)', () => {
    w.bosonPlatform = 'win32';
    viewport(true);
    const { container } = render(<TitleBar onOpenSettings={() => {}} onOpenNotifications={() => {}} userLabel="ada" />);
    expect(container.querySelector('.title-bar')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('stays on a desktop, and on a tablet in the app', () => {
    viewport(false);
    const { container, unmount } = render(<TitleBar onOpenSettings={() => {}} onOpenNotifications={() => {}} notificationsCount={2} userLabel="ada" />);
    expect(container.querySelector('.title-bar')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeTruthy();
    unmount();
    w.bosonPlatform = 'ios';
    const tablet = render(<TitleBar onOpenSettings={() => {}} onOpenNotifications={() => {}} userLabel="ada" />);
    expect(tablet.container.querySelector('.title-bar')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'User settings' })).toBeTruthy();
  });
});

describe('the bell in the rail', () => {
  it('sits under your avatar, above SERVERS, with the unread count, and opens the notifications', () => {
    w.bosonPlatform = 'ios';
    viewport(true);
    const open = vi.fn();
    setNotificationsOpener(open);
    unreadMemos(3);
    const { container } = layout();
    toList();
    expect(container.querySelector('.app-shell')).toHaveClass('phone-home');
    const rail = container.querySelector('.server-rail')!;
    const bell = screen.getByRole('button', { name: 'Notifications, 3 new' });
    expect(rail.contains(bell)).toBe(true);
    // You, the bell, then the SERVERS divider.
    const kids = [...rail.children];
    const you = kids.findIndex((e) => e.classList.contains('my-tile'));
    expect(kids[you + 1]).toBe(bell);
    expect(kids[you + 2]?.classList.contains('rail-divider')).toBe(true);
    expect(bell.querySelector('.notes-bell-badge')).toHaveTextContent('3');
    expect(bell).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(bell);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reads plain "Notifications" with nothing unread', () => {
    w.bosonShell = 'web';
    viewport(true);
    const { container } = layout();
    toList();
    expect(container.querySelector('.server-rail .rail-bell')).toHaveAccessibleName('Notifications');
  });

  it('agrees with the conversation header\'s ⋮', () => {
    w.bosonPlatform = 'android';
    viewport(true);
    setNotificationsOpener(() => {});
    unreadMemos(2);
    setFriendsUi({ phone: 'chat', my: false });
    const { container } = layout();
    expect(container.querySelector('.chat-header-more-dot')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByRole('menuitem', { name: 'Notifications, 2 unread' })).toBeTruthy();
  });

  it('is not in the rail on a desktop, or in a narrow desktop window', () => {
    viewport(false);
    const desk = layout();
    expect(desk.container.querySelector('.rail-bell')).toBeNull();
    desk.unmount();
    w.bosonPlatform = 'linux';
    viewport(true);
    const { container } = layout();
    toList();
    expect(container.querySelector('.server-rail')).not.toBeNull();
    expect(container.querySelector('.rail-bell')).toBeNull();
  });
});

describe('settings on phones', () => {
  it('My space starts with Settings, which opens user settings', () => {
    w.bosonPlatform = 'ios';
    viewport(true);
    const opened: Array<string | null> = [];
    const off = onOpenUserSettings((s) => opened.push(s));
    try {
      render(<MySidebar nick="ada" presence="online" view={null} dms={[]} activeDm={null} onOpenDm={() => {}} showServer={false} />);
      const rows = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
      expect(rows[0]).toBe('Settings');
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      expect(opened).toEqual([null]);
    } finally {
      off();
    }
  });

  it('My space has no Settings row where the title bar has your avatar', () => {
    viewport(false);
    render(<MySidebar nick="ada" presence="online" view={null} dms={[]} activeDm={null} onOpenDm={() => {}} showServer={false} />);
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });
});
