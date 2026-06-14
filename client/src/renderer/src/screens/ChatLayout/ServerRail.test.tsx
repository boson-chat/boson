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
