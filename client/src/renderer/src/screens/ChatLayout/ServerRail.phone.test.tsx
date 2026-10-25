import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import { ServerRail, type ServerRailTile } from './ServerRail';

function tile(over: Partial<ServerRailTile> = {}): ServerRailTile {
  return { serverId: 's1', name: 'Libera.Chat', engineState: 'connected', ...over };
}

function phoneWidth(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function longPress(el: Element): void {
  fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] });
  act(() => { vi.advanceTimersByTime(500); });
  fireEvent.touchEnd(el, { touches: [] });
}

function renderRail(over: Partial<ServerRailTile> = {}) {
  const handlers = {
    onSelectServer: vi.fn(),
    onOpenServerSettings: vi.fn(),
    onLeaveServer: vi.fn(),
    onBouncerConnect: vi.fn(),
    onBouncerDisconnect: vi.fn(),
  };
  render(<ServerRail servers={[tile(over)]} activeServerId="s1" onBrowseServers={vi.fn()} {...handlers} />);
  const btn = document.querySelector('.server-item:not(.server-item-add)') as HTMLElement;
  return { btn, ...handlers };
}

const menuLabels = (): (string | null)[] => screen.getAllByRole('menuitem').map((b) => b.textContent);

let matchMedia: typeof window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers();
  matchMedia = window.matchMedia;
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = matchMedia;
  document.body.querySelectorAll('.bottom-sheet-backdrop').forEach((n) => n.remove());
});

describe('ServerRail on a phone', () => {
  it('a long press opens the server actions in a sheet', () => {
    phoneWidth(true);
    const { btn, onLeaveServer } = renderRail();
    longPress(btn);
    const sheet = screen.getByRole('dialog', { name: 'Libera.Chat' });
    expect(sheet.querySelector('.server-rail-sheet-title')?.textContent).toBe('Libera.Chat');
    expect(menuLabels()).toEqual(['Server details', 'Leave server']);
    const leave = screen.getByRole('menuitem', { name: 'Leave server' });
    expect(leave.classList.contains('bottom-sheet-action-danger')).toBe(true);
    fireEvent.click(leave);
    expect(onLeaveServer).toHaveBeenCalledWith('s1');
  });

  it('offers Connect network when the bouncer upstream is down', () => {
    phoneWidth(true);
    const { btn, onBouncerConnect } = renderRail({ bouncerUpstream: 'disconnected' });
    longPress(btn);
    expect(menuLabels()).toEqual(['Server details', 'Connect network', 'Leave server']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connect network' }));
    expect(onBouncerConnect).toHaveBeenCalledWith('s1');
  });

  it('offers Disconnect network when the bouncer upstream is up', () => {
    phoneWidth(true);
    const { btn } = renderRail({ bouncerUpstream: 'connected' });
    longPress(btn);
    expect(menuLabels()).toEqual(['Server details', 'Disconnect network', 'Leave server']);
  });

  it('shows no name tooltip and no context menu', () => {
    phoneWidth(true);
    const { btn } = renderRail();
    fireEvent.mouseEnter(btn);
    expect(document.querySelector('.server-rail-tooltip')).toBeNull();
    fireEvent.contextMenu(btn, { clientX: 5, clientY: 5 });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a tap still selects the server', () => {
    phoneWidth(true);
    const { btn, onSelectServer } = renderRail();
    fireEvent.click(btn);
    expect(onSelectServer).toHaveBeenCalledWith('s1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the tooltip and right-click menu on a wide window, with no sheet', () => {
    phoneWidth(false);
    const { btn } = renderRail();
    longPress(btn);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.mouseEnter(btn);
    expect(document.querySelector('.server-rail-tooltip')?.textContent).toBe('Libera.Chat');
  });
});
