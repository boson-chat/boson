import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { ChannelSidebar, cssUrl } from './ChannelSidebar';

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
