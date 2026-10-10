import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ServerRail, type ServerRailTile } from './ServerRail';

// ServerRail renders one tile per connected server. A tile shows the owner's
// uploaded icon (icon_url) when present, otherwise the name initials.

function tile(over: Partial<ServerRailTile> = {}): ServerRailTile {
  return { serverId: 's1', name: 'boson', engineState: 'connected', ...over };
}

describe('ServerRail icon', () => {
  it('renders the server icon image when iconUrl is set', () => {
    render(
      <ServerRail
        servers={[tile({ iconUrl: 'https://cdn.boson.chat/server-icons/s1.png' })]}
        activeServerId="s1"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
      />,
    );
    const img = document.querySelector('img.server-item-icon') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.src).toContain('/server-icons/s1.png');
    // Initials must NOT render when an icon is present.
    expect(screen.queryByText('BO')).toBeNull();
  });

  it('falls back to initials when no iconUrl', () => {
    render(
      <ServerRail
        servers={[tile({ name: 'boson' })]}
        activeServerId="s1"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
      />,
    );
    expect(document.querySelector('img.server-item-icon')).toBeNull();
    expect(screen.getByText('BO')).toBeTruthy();
  });
});

describe('ServerRail hover name flyout', () => {
  it('shows the full server name on tile hover and hides on leave', () => {
    render(
      <ServerRail
        servers={[tile({ name: 'Libera.Chat' })]}
        activeServerId="s1"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
      />,
    );
    expect(document.querySelector('.server-rail-tooltip')).toBeNull();
    const btn = document.querySelector('.server-item:not(.server-item-add)') as HTMLElement;
    fireEvent.mouseEnter(btn);
    const tip = document.querySelector('.server-rail-tooltip');
    expect(tip?.textContent).toBe('Libera.Chat');
    fireEvent.mouseLeave(btn);
    expect(document.querySelector('.server-rail-tooltip')).toBeNull();
  });
});

describe('ServerRail context menu — bouncer network items', () => {
  function openMenu(t: ServerRailTile, handlers: { onBouncerConnect?: (id: string) => void; onBouncerDisconnect?: (id: string) => void } = {}) {
    render(
      <ServerRail
        servers={[t]}
        activeServerId="s1"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
        onOpenServerSettings={vi.fn()}
        onLeaveServer={vi.fn()}
        {...handlers}
      />,
    );
    const btn = document.querySelector('.server-item:not(.server-item-add)') as HTMLElement;
    fireEvent.contextMenu(btn);
  }

  it('upstream disconnected → "Connect network"', () => {
    const onBouncerConnect = vi.fn();
    openMenu(tile({ bouncerUpstream: 'disconnected' }), { onBouncerConnect, onBouncerDisconnect: vi.fn() });
    expect(screen.queryByRole('menuitem', { name: 'Disconnect network' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect network' }));
    expect(onBouncerConnect).toHaveBeenCalledWith('s1');
    // Menu closes after the action.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('upstream connected → "Disconnect network"', () => {
    const onBouncerDisconnect = vi.fn();
    openMenu(tile({ bouncerUpstream: 'connected' }), { onBouncerConnect: vi.fn(), onBouncerDisconnect });
    expect(screen.queryByRole('menuitem', { name: 'Connect network' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect network' }));
    expect(onBouncerDisconnect).toHaveBeenCalledWith('s1');
  });

  it('direct (non-bouncer) server → no network items', () => {
    openMenu(tile(), { onBouncerConnect: vi.fn(), onBouncerDisconnect: vi.fn() });
    expect(screen.getByRole('menuitem', { name: 'Server details' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /network/ })).toBeNull();
  });

  it('bouncer link itself down → no network items (stale upstream ignored)', () => {
    openMenu(tile({ engineState: 'disconnected', bouncerUpstream: 'connected' }), {
      onBouncerConnect: vi.fn(), onBouncerDisconnect: vi.fn(),
    });
    expect(screen.queryByRole('menuitem', { name: /network/ })).toBeNull();
  });

  it('flyout says "network offline" for an attached-but-offline bouncer', () => {
    render(
      <ServerRail
        servers={[tile({ name: 'Libera', bouncerUpstream: 'disconnected' })]}
        activeServerId="s1"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
      />,
    );
    const btn = document.querySelector('.server-item:not(.server-item-add)') as HTMLElement;
    fireEvent.mouseEnter(btn);
    expect(document.querySelector('.server-rail-tooltip')?.textContent).toBe('Libera (network offline)');
  });
});
