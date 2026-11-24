import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { ChatArea } from './ChatArea';
import { ChatLayout } from './ChatLayout';
import { SETTLE_MS } from './useSwipeNav';
import { setNotificationsOpener } from '../../modules/ui/open-notifications';
import { getFriendsUi, setFriendsUi } from '../Friends/friends-ui';
import type { ChatChannel, ChatService, ChatState } from '../../modules/chat';

// A phone's conversation header (design D): ← #name, Search, and ⋮ with
// Members, Notifications and Channel settings. Swipe left for the members.

const channel = {
  name: '#team-infrastructure-ops', joined: true, members: [{ nick: 'ada', prefix: '' }, { nick: 'me', prefix: '' }],
  messages: [], typing: [], unread: 0, mentions: 0, topic: 'Deploys at noon',
} as unknown as ChatChannel;
const dm = { ...channel, name: 'mox', members: [], topic: '' } as unknown as ChatChannel;

let shell: unknown;
beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: true, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  // The title bar steps aside (the web build / the phone app): the bell
  // lives in the conversation header.
  shell = (window as { bosonShell?: unknown }).bosonShell;
  (window as { bosonShell?: unknown }).bosonShell = 'web';
});
afterEach(() => {
  vi.unstubAllGlobals();
  (window as { bosonShell?: unknown }).bosonShell = shell;
  setNotificationsOpener(null);
  setFriendsUi({ phone: null });
});

describe('ChatArea on a phone: the header', () => {
  it('keeps the name, Search and ⋮; the topic, shield, members, gear and bell leave', () => {
    setNotificationsOpener(() => {});
    const { container } = render(
      <ChatArea channel={channel} myNick="me" onSend={vi.fn()} onBack={vi.fn()}
        registration={{ registered: true, founder: 'me' }} onOpenRegistration={vi.fn()}
        onShowMembers={vi.fn()} onOpenChannelSettings={vi.fn()} />,
    );
    const names = [...container.querySelectorAll('.chat-header button')].map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Back to channels', 'Search in #team-infrastructure-ops', 'More options']);
    expect(container.querySelector('.chat-channel-label')).toHaveTextContent('team-infrastructure-ops');
    expect(container.querySelector('.chat-channel-topic')).toBeNull();
    expect(container.querySelector('.chat-reg-badge')).toBeNull();
  });

  it('⋮ opens Members, Notifications and Channel settings, in that order, each opening its page', () => {
    const onMembers = vi.fn();
    const onSettings = vi.fn();
    const onNotes = vi.fn();
    setNotificationsOpener(onNotes);
    render(<ChatArea channel={channel} myNick="me" onSend={vi.fn()} onShowMembers={onMembers} onOpenChannelSettings={onSettings} />);
    const more = screen.getByRole('button', { name: 'More options' });
    expect(more).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem').map((m) => m.getAttribute('aria-label') ?? m.textContent);
    expect(items).toEqual(['Members (2)', 'Notifications', 'Channel settings']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Members (2)' }));
    expect(onMembers).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Notifications' }));
    expect(onNotes).toHaveBeenCalledTimes(1);

    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Channel settings' }));
    expect(onSettings).toHaveBeenCalledTimes(1);

    // ⋮ again closes it; so does Escape.
    fireEvent.click(more);
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a DM: only Notifications; no ⋮ at all when that doesn\'t apply either', () => {
    setNotificationsOpener(() => {});
    const { unmount } = render(<ChatArea channel={dm} myNick="me" onSend={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.getAttribute('aria-label'))).toEqual(['Notifications']);
    unmount();

    setNotificationsOpener(null);
    render(<ChatArea channel={dm} myNick="me" onSend={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull();
  });
});

// The phone's screens: swiping left on a channel's conversation opens its
// members, as the menu's Members does; right goes back.
function fakeChat(state: ChatState): ChatService {
  return {
    getState: vi.fn(() => state),
    subscribe: vi.fn((cb: (s: ChatState) => void) => { cb(state); return () => {}; }),
    onFeedback: vi.fn(() => () => {}),
    join: vi.fn(), part: vi.fn(), send: vi.fn(), input: vi.fn(), setActive: vi.fn(), attach: vi.fn(), detach: vi.fn(),
    setNick: vi.fn(), clearServerLog: vi.fn(), sendTyping: vi.fn(),
  } as unknown as ChatService;
}

describe('ChatLayout on a phone: swipe', () => {
  const state = {
    channels: [{ ...channel, name: '#general' }], activeChannel: '#general', serverLog: [], serverInfo: {},
    channelDirectory: { status: 'idle', entries: [], updatedAt: null }, myNick: 'me', myOper: false, servicesFramework: null,
  } as unknown as ChatState;

  function drag(el: HTMLElement, from: number, to: number): void {
    const at = (x: number) => ({ touches: [{ clientX: x, clientY: 300 }] });
    fireEvent.touchStart(el, at(from));
    for (let i = 1; i <= 4; i++) fireEvent.touchMove(el, at(from + ((to - from) * i) / 4));
    fireEvent.touchEnd(el, { touches: [] });
  }

  it('left on the conversation opens Members; right goes back', () => {
    vi.useFakeTimers();
    try {
      setFriendsUi({ phone: 'chat', my: false });
      const { container } = render(<ChatLayout chat={fakeChat(state)} serverName="local" myNick="me" onBrowseServers={() => {}} />);
      const stack = container.querySelector<HTMLElement>('.phone-stack')!;
      Object.defineProperty(stack, 'clientWidth', { configurable: true, value: 339 });
      expect(container.querySelector('.chat-area')).not.toBeNull();

      drag(stack, 300, 60);
      act(() => { vi.advanceTimersByTime(SETTLE_MS + 10); });
      expect(getFriendsUi().phone).toBe('members');

      drag(stack, 40, 280);
      act(() => { vi.advanceTimersByTime(SETTLE_MS + 10); });
      expect(getFriendsUi().phone).toBe('chat');
    } finally {
      vi.useRealTimers();
    }
  });
});
