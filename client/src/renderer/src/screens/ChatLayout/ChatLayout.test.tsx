import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ChatLayout } from './ChatLayout';
import type { ChatService, ChatState } from '../../modules/chat';

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

const emptyState: ChatState = {
  channels: [],
  activeChannel: null,
  serverLog: [],
  serverInfo: {},
  channelDirectory: { status: 'idle', entries: [], updatedAt: null },
  myNick: 'me',
  servicesFramework: null,
};

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
  servicesFramework: null,
};

describe('ChatLayout', () => {
  it('renders all four columns', () => {
    render(
      <ChatLayout
        chat={buildFakeChat(emptyState)}
        serverName="Boson HQ"
        myNick="me"
        onBrowseServers={() => {}}
      />,
    );
    // Server rail (initials of "Boson HQ" = "BH")
    expect(screen.getByText('BH')).toBeInTheDocument();
    // Channel sidebar title
    expect(screen.getAllByText('Boson HQ').length).toBeGreaterThan(0);
    // User panel
    expect(screen.getByText('Members', { exact: false })).toBeInTheDocument();
  });

  it('renders active channel header and messages', () => {
    render(
      <ChatLayout
        chat={buildFakeChat(populatedState)}
        serverName="local"
        myNick="me"
        onBrowseServers={() => {}}
      />,
    );
    // "general" appears in both the channel sidebar row and the chat header — assert at least one.
    expect(screen.getAllByText('general').length).toBeGreaterThan(0);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('routes Send button text through chat.input (which parses slash commands)', async () => {
    const input = vi.fn();
    const chat = buildFakeChat(populatedState, { input });
    render(
      <ChatLayout chat={chat} serverName="local" myNick="me" onBrowseServers={() => {}} />,
    );
    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText('Message #general');
    await user.type(textarea, 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(input).toHaveBeenCalledWith('hello');
  });

  it('browse-servers button triggers callback', async () => {
    const onBrowseServers = vi.fn();
    render(
      <ChatLayout
        chat={buildFakeChat(emptyState)}
        serverName="local"
        myNick="me"
        onBrowseServers={onBrowseServers}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Browse / switch servers' }));
    expect(onBrowseServers).toHaveBeenCalledOnce();
  });

  it('sidebar gear button opens server details for the active server', async () => {
    const onOpenServerSettings = vi.fn();
    render(
      <ChatLayout
        chat={buildFakeChat(emptyState)}
        serverName="Boson HQ"
        myNick="me"
        activeServerId="srv-42"
        onBrowseServers={() => {}}
        onOpenServerSettings={onOpenServerSettings}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Server details' }));
    expect(onOpenServerSettings).toHaveBeenCalledWith('srv-42');
  });

  it('hides the sidebar gear button when no server-settings handler is wired', () => {
    render(
      <ChatLayout
        chat={buildFakeChat(emptyState)}
        serverName="Boson HQ"
        myNick="me"
        onBrowseServers={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Server details' })).not.toBeInTheDocument();
  });

  it('hides the sidebar gear button when active server id is unknown', () => {
    const onOpenServerSettings = vi.fn();
    render(
      <ChatLayout
        chat={buildFakeChat(emptyState)}
        serverName="Boson HQ"
        myNick="me"
        onBrowseServers={() => {}}
        onOpenServerSettings={onOpenServerSettings}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Server details' })).not.toBeInTheDocument();
  });
});
