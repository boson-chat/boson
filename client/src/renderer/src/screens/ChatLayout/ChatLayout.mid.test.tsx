import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import { ChatLayout } from './ChatLayout';
import type { ChatService, ChatState } from '../../modules/chat';
import { MID_QUERY } from '../../shared/narrow';

// Tablet portrait (768px): the member list isn't a fixed column; the
// header's Members button opens it over the chat, and it closes again.
function midWidth(): void {
  window.matchMedia = ((query: string) => ({
    matches: query === MID_QUERY, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function buildFakeChat(state: ChatState, overrides: Partial<ChatService> = {}): ChatService {
  const base = {
    getState: vi.fn(() => state),
    subscribe: vi.fn((cb: (s: ChatState) => void) => { cb(state); return () => {}; }),
    onFeedback: vi.fn(() => () => {}),
    join: vi.fn(),
    part: vi.fn(),
    send: vi.fn(),
    input: vi.fn(),
    setActive: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    setNick: vi.fn(),
    clearServerLog: vi.fn(),
    sendTyping: vi.fn(),
  };
  return { ...base, ...overrides } as unknown as ChatService;
}

const populatedState: ChatState = {
  channels: [
    {
      name: '#general',
      joined: true,
      members: [
        { nick: 'alice', prefix: '@' },
        { nick: 'me', prefix: '' },
      ],
      messages: [
        { id: '1', kind: 'message', from: 'alice', text: 'Hello world', timestamp: Date.now() },
      ],
      typing: [],
      unread: 0,
      mentions: 0,
      topic: '',
    },
  ],
  activeChannel: '#general',
  serverLog: [],
  serverInfo: {},
  channelDirectory: { status: 'idle', entries: [], updatedAt: null },
  myNick: 'me',
  myOper: false,
  servicesFramework: null,
};

let matchMedia: typeof window.matchMedia;
beforeEach(() => { matchMedia = window.matchMedia; midWidth(); });
afterEach(() => { window.matchMedia = matchMedia; });

describe('ChatLayout at mid width', () => {
  const renderMid = () => render(
    <ChatLayout chat={buildFakeChat(populatedState)} serverName="local" myNick="me" onBrowseServers={() => {}} />,
  );

  it('hides the member list until the Members button opens it as an overlay', () => {
    const { container } = renderMid();
    expect(container.querySelector('.app-shell.is-mid')).not.toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Members' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize member list' })).toBeNull();

    const btn = screen.getByRole('button', { name: 'Members (2)' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    const panel = screen.getByRole('complementary', { name: 'Members' });
    expect(panel.closest('.mid-panel-layer')).not.toBeNull();

    // A tap inside the panel keeps it; the scrim around it closes it.
    fireEvent.click(panel);
    expect(screen.getByRole('complementary', { name: 'Members' })).toBeInTheDocument();
    fireEvent.click(container.querySelector('.mid-panel-layer')!);
    expect(screen.queryByRole('complementary', { name: 'Members' })).toBeNull();
  });

  it('closes the overlay on Escape and toggles from the button', () => {
    renderMid();
    const btn = screen.getByRole('button', { name: 'Members (2)' });
    fireEvent.click(btn);
    expect(screen.getByRole('complementary', { name: 'Members' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Members' })).toBeNull();
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(screen.queryByRole('complementary', { name: 'Members' })).toBeNull();
  });
});
