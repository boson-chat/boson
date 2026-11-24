import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { ChannelSidebar, channelSync, cssUrl } from './ChannelSidebar';
import type { ChatChannel } from '../../modules/chat';

const baseProps = {
  serverName: 'boson',
  channels: [],
  activeChannel: null,
  onSelect: vi.fn(),
  onJoin: vi.fn(),
  onPart: vi.fn(),
};

describe('ChannelSidebar banner', () => {
  it('renders the banner as the header background when bannerUrl is set', () => {
    render(<ChannelSidebar {...baseProps} bannerUrl="https://cdn.boson.chat/server-banners/b1.png" />);
    const header = document.querySelector('.channel-sidebar-header') as HTMLElement;
    expect(header.classList.contains('channel-sidebar-header-banner')).toBe(true);
    expect(header.getAttribute('style') ?? '').toContain('server-banners/b1.png');
    // Server name still shown, overlaid on the banner.
    expect(screen.getByText('boson')).toBeTruthy();
  });

  it('renders a plain header (no banner class/style) when bannerUrl is absent', () => {
    render(<ChannelSidebar {...baseProps} />);
    const header = document.querySelector('.channel-sidebar-header') as HTMLElement;
    expect(header.classList.contains('channel-sidebar-header-banner')).toBe(false);
    expect(header.getAttribute('style')).toBeNull();
    expect(screen.getByText('boson')).toBeTruthy();
  });

});

describe('ChannelSidebar server subtitle', () => {
  it('shows the server description, not the daemon version (kept in the tooltip)', () => {
    render(<ChannelSidebar {...baseProps} serverDescription="Chat about Boson" serverInfo={{ version: 'ergo-v2.19.1' } as never} />);
    const meta = document.querySelector('.sidebar-server-meta') as HTMLElement;
    expect(meta.textContent).toContain('Chat about Boson');
    expect(meta.textContent).not.toContain('ergo-v2.19.1');
    expect(meta.getAttribute('title')).toContain('ergo-v2.19.1');
  });
});

describe('cssUrl', () => {
  it('passes a normal URL through unchanged', () => {
    expect(cssUrl('https://cdn.boson.chat/server-banners/b1.png')).toBe(
      'https://cdn.boson.chat/server-banners/b1.png',
    );
  });

  it('escapes quotes, backslashes and parens so a URL cannot break out of url("...")', () => {
    // Without escaping, the `")` would close the url() + value and let the
    // rest inject arbitrary CSS. After escaping each is backslash-prefixed.
    expect(cssUrl('https://x/a")evil("b.png')).toBe('https://x/a\\"\\)evil\\(\\"b.png');
  });
});

describe('ChannelSidebar bouncer upstream meta', () => {
  const meta = () => document.querySelector('.sidebar-server-meta') as HTMLElement;
  const dot = () => document.querySelector('.sidebar-status-dot') as HTMLElement;

  it('plain bouncer link (no upstream report) reads Connected via bouncer', () => {
    render(<ChannelSidebar {...baseProps} engineState="connected" serverInfo={{ bouncer: true }} />);
    expect(dot().dataset.state).toBe('connected');
    expect(meta().title).toContain('Connected via bouncer');
  });

  it('configured bouncer, upstream not reported yet: connecting, not Connected', () => {
    render(<ChannelSidebar {...baseProps} engineState="connected" serverInfo={{ bouncer: true, bouncerConfigured: true }} />);
    expect(dot().dataset.state).toBe('connecting');
    expect(dot().getAttribute('aria-label')).toBe('Bouncer connected · network connecting…');
  });

  it('upstream offline: warn dot + "Bouncer connected · network offline" tooltip', () => {
    render(<ChannelSidebar {...baseProps} engineState="connected" serverInfo={{ bouncer: true, bouncerUpstream: 'disconnected' }} />);
    expect(dot().dataset.state).toBe('upstream-offline');
    expect(dot().getAttribute('aria-label')).toBe('Bouncer connected · network offline');
    expect(meta().title).toContain('Bouncer connected · network offline');
    expect(screen.getByLabelText('via bouncer, network offline')).toBeTruthy();
  });

  it('upstream connecting: connecting dot', () => {
    render(<ChannelSidebar {...baseProps} engineState="connected" serverInfo={{ bouncer: true, bouncerUpstream: 'connecting' }} />);
    expect(dot().dataset.state).toBe('connecting');
    expect(meta().title).toContain('network connecting');
  });

  it('upstream connected: plain Connected', () => {
    render(<ChannelSidebar {...baseProps} engineState="connected" serverInfo={{ bouncer: true, bouncerUpstream: 'connected' }} />);
    expect(dot().dataset.state).toBe('connected');
    expect(dot().getAttribute('aria-label')).toBe('Connected');
  });

  it('bouncer link down: engine state wins over a stale upstream', () => {
    render(<ChannelSidebar {...baseProps} engineState="disconnected" serverInfo={{ bouncer: true, bouncerUpstream: 'connected' }} />);
    expect(dot().dataset.state).toBe('disconnected');
  });
});

describe('channel join progress', () => {
  const chan = (over: Partial<ChatChannel>): ChatChannel => ({
    name: '#ai', messages: [], joined: true, members: [], typing: [], unread: 0, mentions: 0, topic: '', ...over,
  });

  it('is joining until the server confirms the JOIN', () => {
    expect(channelSync(chan({ joined: false }))).toBe('joining');
  });

  it('is loading until both the member list and away status have arrived', () => {
    expect(channelSync(chan({ namesLoaded: false, whoLoaded: false }))).toBe('loading');
    // The WHO (away status, details) fills in later; it doesn't hold it up.
    expect(channelSync(chan({ namesLoaded: true, whoLoaded: false }))).toBe('ready');
    expect(channelSync(chan({ namesLoaded: true, whoLoaded: true }))).toBe('ready');
  });

  it('treats DMs as ready', () => {
    expect(channelSync(chan({ name: 'lynx', joined: false }))).toBe('ready');
  });

  it('marks each row with its state', () => {
    render(
      <ChannelSidebar
        {...baseProps}
        channels={[
          chan({ name: '#a', joined: false }),
          chan({ name: '#b', namesLoaded: false, whoLoaded: false }),
          chan({ name: '#c', namesLoaded: true, whoLoaded: true }),
        ]}
      />,
    );
    const row = (n: string) => screen.getByText(n).closest('.channel-item') as HTMLElement;
    expect(row('a').dataset.sync).toBe('joining');
    expect(row('a').getAttribute('title')).toBe('Joining…');
    expect(row('b').dataset.sync).toBe('loading');
    expect(row('b').getAttribute('aria-busy')).toBe('true');
    expect(row('c').dataset.sync).toBe('ready');
    expect(row('c').getAttribute('title')).toBeNull();
  });
});

describe('ChannelSidebar join modal — admins-only channel creation', () => {
  const open = async () => {
    const { fireEvent } = await import('@testing-library/preact');
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    return fireEvent;
  };
  const lobby = { name: '#lobby', topic: 'Welcome', autojoin: true };
  const joined = (name: string): ChatChannel => ({ name, joined: true, messages: [] as never, members: [], typing: [], unread: 0, mentions: 0, topic: '' }) as unknown as ChatChannel;

  it('says only admins can create channels, and offers the network channels', async () => {
    const onJoin = vi.fn();
    render(<ChannelSidebar {...baseProps} onJoin={onJoin} channelDirectory={[{ name: '#dev', userCount: 3, topic: '' }]} creation={{ restricted: true, channels: [lobby, { name: '#help' }] }} />);
    expect(screen.getByRole('button', { name: 'Add channel' }).getAttribute('title')).toBe('Join a channel');
    const fireEvent = await open();
    expect(screen.getByTestId('channel-create-restricted').textContent).toContain('Only admins can create channels on this network.');
    fireEvent.input(screen.getByPlaceholderText(/Search channels/), { target: { value: '#brandnew' } });
    expect(screen.getByText('No channels match. Only admins can create new channels here.')).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Network channels' });
    expect(group.textContent).toContain('#lobby');
    fireEvent.click(screen.getByRole('button', { name: '#help' }));
    expect(onJoin).toHaveBeenCalledWith('#help');
  });

  it('does not suggest a network channel we are already in', async () => {
    render(<ChannelSidebar {...baseProps} channels={[joined('#lobby')]} creation={{ restricted: true, channels: [lobby] }} />);
    await open();
    expect(screen.queryByRole('group', { name: 'Network channels' })).toBeNull();
  });

  it('admins (or open creation) see the ordinary join modal', async () => {
    render(<ChannelSidebar {...baseProps} creation={{ restricted: false, channels: [lobby] }} />);
    expect(screen.getByRole('button', { name: 'Add channel' }).getAttribute('title')).toBe('Join a new channel');
    await open();
    expect(screen.queryByTestId('channel-create-restricted')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Network channels' })).toBeNull();
    expect(screen.getByText('Waiting for the server', { exact: false })).toBeTruthy();
  });

  it('join or create: nothing preselected, a Create row for a new name, Enter acts on what was typed', async () => {
    const onJoin = vi.fn();
    const dir = [{ name: '#general', userCount: 40, topic: 'chat' }, { name: '#gen-z', userCount: 2, topic: '' }];
    render(<ChannelSidebar {...baseProps} onJoin={onJoin} channelDirectory={dir} creation={{ restricted: false, channels: [] }} />);
    const fireEvent = await open();
    expect(screen.getByRole('dialog', { name: 'Join or create a channel' })).toBeTruthy();
    // Nothing is picked until the user picks it.
    expect(document.querySelector('.channel-join-result[aria-selected="true"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Join' })).toHaveProperty('disabled', true);

    // A new name, with list matches: Create it, not the first match.
    const box = screen.getByRole('textbox', { name: 'Channel name' });
    fireEvent.input(box, { target: { value: 'gen' } });
    // The Create row, and the main button says so too.
    expect(screen.getAllByRole('button', { name: 'Create #gen' })).toHaveLength(2);
    expect(document.querySelector('.channel-join-create')?.textContent).toContain('Create #gen');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onJoin).toHaveBeenLastCalledWith('gen');
  });

  it('join or create: a typed name the list has joins it; arrows pick a row', async () => {
    const onJoin = vi.fn();
    const dir = [{ name: '#general', userCount: 40, topic: 'chat' }, { name: '#gen-z', userCount: 2, topic: '' }];
    render(<ChannelSidebar {...baseProps} onJoin={onJoin} channelDirectory={dir} creation={{ restricted: false, channels: [] }} />);
    const fireEvent = await open();
    const box = screen.getByRole('textbox', { name: 'Channel name' });
    fireEvent.input(box, { target: { value: '#gen-z' } });
    expect(document.querySelector('.channel-join-create')).toBeNull();
    expect(screen.getByRole('button', { name: 'Join #gen-z' })).toBeTruthy();
    fireEvent.input(box, { target: { value: 'gen' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'Join #general' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onJoin).toHaveBeenLastCalledWith('#general');
  });
});

describe('ChannelSidebar leaving (in the row menu, not an ×)', () => {
  const joinedChan = (name: string): ChatChannel => ({ name, joined: true, namesLoaded: true, whoLoaded: true, messages: [] as never, members: [], typing: [], unread: 0, mentions: 0, topic: '' }) as unknown as ChatChannel;

  it('a row has no leave button; its "…" menu has Leave channel', async () => {
    const { fireEvent } = await import('@testing-library/preact');
    const onPart = vi.fn();
    render(<ChannelSidebar {...baseProps} onPart={onPart} channels={[joinedChan('#dev')]} />);
    expect(screen.queryByRole('button', { name: /^Leave/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More for #dev' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave channel' }));
    expect(onPart).toHaveBeenCalledWith('#dev');
  });

  it('a DM row shows an avatar and offers Close conversation', async () => {
    const { fireEvent } = await import('@testing-library/preact');
    const onPart = vi.fn();
    const { container } = render(<ChannelSidebar {...baseProps} onPart={onPart} channels={[joinedChan('#dev'), joinedChan('mox')]} />);
    const row = screen.getByText('mox').closest('.channel-item') as HTMLElement;
    expect(row.querySelector('.channel-lead')).not.toBeNull();
    expect(container.textContent).not.toContain('[DM]');
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close conversation' }));
    expect(onPart).toHaveBeenCalledWith('mox');
  });

  it('DIRECT MESSAGES links to every DM (You) when wired', async () => {
    const { fireEvent } = await import('@testing-library/preact');
    const onOpenAllDms = vi.fn();
    render(<ChannelSidebar {...baseProps} onOpenAllDms={onOpenAllDms} channels={[joinedChan('mox')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'All direct messages' }));
    expect(onOpenAllDms).toHaveBeenCalled();
  });
});
