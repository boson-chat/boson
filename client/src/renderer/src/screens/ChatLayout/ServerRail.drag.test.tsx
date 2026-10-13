// @vitest-environment jsdom
// jsdom, not happy-dom: happy-dom elements lack ondragstart/ondragover/…,
// so Preact would listen for "DragOver" and never see a real "dragover".
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { ServerRail, reorderedIds, type ServerRailTile } from './ServerRail';

function tile(over: Partial<ServerRailTile> = {}): ServerRailTile {
  return { serverId: 's1', name: 'boson', engineState: 'connected', ...over };
}

describe('ServerRail drag to reorder', () => {
  it('reorderedIds moves the dragged id beside the target', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(reorderedIds(ids, 'a', { serverId: 'c', after: true })).toEqual(['b', 'c', 'a', 'd']);
    expect(reorderedIds(ids, 'd', { serverId: 'a', after: false })).toEqual(['d', 'a', 'b', 'c']);
    expect(reorderedIds(ids, 'b', { serverId: 'b', after: true })).toEqual(ids);
    expect(reorderedIds(ids, 'b', { serverId: 'zz', after: true })).toEqual(ids);
  });

  function renderRail(onReorderServers = vi.fn()) {
    render(
      <ServerRail
        servers={[tile({ serverId: 'a', name: 'aa' }), tile({ serverId: 'b', name: 'bb' }), tile({ serverId: 'c', name: 'cc' })]}
        activeServerId="a"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
        onReorderServers={onReorderServers}
      />,
    );
    const tiles = Array.from(document.querySelectorAll<HTMLElement>('.server-item:not(.server-item-add)'));
    // No layout in jsdom: give each tile a 48px-tall box, stacked.
    tiles.forEach((el, i) => {
      el.getBoundingClientRect = () => ({ top: i * 56, bottom: i * 56 + 48, height: 48, left: 0, right: 48, width: 48, x: 0, y: i * 56, toJSON: () => ({}) }) as DOMRect;
    });
    return { tiles, onReorderServers };
  }

  // jsdom has no DragEvent; a MouseEvent of the drag type carries clientY.
  const dragAt = (el: Element, type: 'dragover' | 'drop', clientY: number): void => {
    fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
  };

  it('dropping a tile on the lower half of another moves it below that one', () => {
    const { tiles, onReorderServers } = renderRail();
    expect(tiles[0]!.getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(tiles[0]!);
    dragAt(tiles[2]!, 'dragover', 2 * 56 + 40);
    expect(tiles[2]!.classList.contains('server-item-drop-after')).toBe(true);
    dragAt(tiles[2]!, 'drop', 2 * 56 + 40);
    expect(onReorderServers).toHaveBeenCalledWith(['b', 'c', 'a']);
    expect(document.querySelector('.server-item-drop-after, .server-item-drop-before')).toBeNull();
  });

  it('dropping a tile back where it was does not call onReorderServers', () => {
    const { tiles, onReorderServers } = renderRail();
    fireEvent.dragStart(tiles[1]!);
    dragAt(tiles[0]!, 'dragover', 40);
    dragAt(tiles[0]!, 'drop', 40);
    expect(onReorderServers).not.toHaveBeenCalled();
  });

  it('tiles are not draggable without onReorderServers', () => {
    render(
      <ServerRail
        servers={[tile({ serverId: 'a' }), tile({ serverId: 'b' })]}
        activeServerId="a"
        onSelectServer={vi.fn()}
        onBrowseServers={vi.fn()}
      />,
    );
    const first = document.querySelector('.server-item:not(.server-item-add)')!;
    expect(first.getAttribute('draggable')).not.toBe('true');
  });
});
