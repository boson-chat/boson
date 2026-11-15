// @vitest-environment jsdom
// jsdom, not happy-dom: happy-dom elements lack ondragstart/ondragover/…,
// so Preact would listen for "DragOver" and never see a real "dragover".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/preact';
import { ChannelSidebar } from './ChannelSidebar';
import { HOLD_MS } from './channel-reorder';
import type { ChatChannel } from '../../modules/chat';

const ch = (name: string): ChatChannel => ({
  name, messages: [], joined: true, members: [], typing: [], unread: 0, mentions: 0, topic: '', namesLoaded: true,
}) as unknown as ChatChannel;

function renderSidebar(over: Partial<Parameters<typeof ChannelSidebar>[0]> = {}) {
  const onReorderChannels = vi.fn();
  const onResetChannelOrder = vi.fn();
  const onSelect = vi.fn();
  const utils = render(
    <ChannelSidebar
      serverName="boson"
      channels={[ch('#a'), ch('#b'), ch('#c'), ch('alice'), ch('bob')]}
      activeChannel={null}
      onSelect={onSelect}
      onJoin={vi.fn()}
      onPart={vi.fn()}
      onReorderChannels={onReorderChannels}
      onResetChannelOrder={onResetChannelOrder}
      {...over}
    />,
  );
  const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.channel-item'));
  // No layout in jsdom: stack the rows 32px apart.
  const layout = (): void => rows().forEach((el, i) => {
    el.getBoundingClientRect = () => ({ top: i * 32, bottom: i * 32 + 32, height: 32, left: 0, right: 200, width: 200, x: 0, y: i * 32, toJSON: () => ({}) }) as DOMRect;
  });
  layout();
  const row = (name: string): HTMLElement => rows().find((r) => r.dataset['reorderName'] === name)!;
  return { ...utils, rows, row, layout, onReorderChannels, onResetChannelOrder, onSelect };
}

const dragAt = (el: Element, type: 'dragover' | 'drop', clientY: number): void => {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
};

afterEach(() => { vi.useRealTimers(); });

describe('ChannelSidebar reorder', () => {
  it('shows rows in the saved order, new channels after', () => {
    const { rows } = renderSidebar({ channelOrder: ['#c', '#a', 'bob'] });
    expect(rows().map((r) => r.dataset['reorderName'])).toEqual(['#c', '#a', '#b', 'bob', 'alice']);
  });

  it('drags a channel below another, with a drop line, and reports the section order', () => {
    const { row, onReorderChannels } = renderSidebar();
    expect(row('#a').getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(row('#a'));
    expect(row('#a').classList.contains('channel-item-dragging')).toBe(true);
    // Lower half of #c (rows at 0, 32, 64): lands after #c — the last
    // channel, so the line sits under it.
    dragAt(row('#c'), 'dragover', 64 + 24);
    expect(row('#c').classList.contains('channel-item-drop-after')).toBe(true);
    dragAt(row('#c'), 'drop', 64 + 24);
    expect(onReorderChannels).toHaveBeenCalledWith(['#b', '#c', '#a']);
    expect(document.querySelector('.channel-item-drop-before, .channel-item-drop-after, .channel-item-dragging')).toBeNull();
  });

  it('shows the line above the row below the landing spot', () => {
    const { row } = renderSidebar();
    fireEvent.dragStart(row('#c'));
    dragAt(row('#a'), 'dragover', 24); // after #a → above #b
    expect(row('#b').classList.contains('channel-item-drop-before')).toBe(true);
    expect(row('#a').classList.contains('channel-item-drop-after')).toBe(false);
  });

  it('does not drop across sections or back in place', () => {
    const { row, onReorderChannels } = renderSidebar();
    fireEvent.dragStart(row('#a'));
    dragAt(row('alice'), 'dragover', 3 * 32 + 4);
    expect(document.querySelector('.channel-item-drop-before, .channel-item-drop-after')).toBeNull();
    dragAt(row('#a'), 'dragover', 4);
    expect(document.querySelector('.channel-item-drop-before, .channel-item-drop-after')).toBeNull();
    dragAt(row('#a'), 'drop', 4);
    expect(onReorderChannels).not.toHaveBeenCalled();
  });

  it('reorders DMs within their own section', () => {
    const { row, onReorderChannels } = renderSidebar();
    fireEvent.dragStart(row('bob'));
    dragAt(row('alice'), 'dragover', 3 * 32 + 4);
    dragAt(row('alice'), 'drop', 3 * 32 + 4);
    expect(onReorderChannels).toHaveBeenCalledWith(['bob', 'alice']);
  });

  it('Alt+Down / Alt+Up move the focused row', () => {
    const { row, onReorderChannels, onSelect } = renderSidebar();
    fireEvent.keyDown(row('#a'), { key: 'ArrowDown', altKey: true });
    expect(onReorderChannels).toHaveBeenLastCalledWith(['#b', '#a', '#c']);
    fireEvent.keyDown(row('#a'), { key: 'ArrowUp', altKey: true });
    expect(onReorderChannels).toHaveBeenCalledTimes(1); // already first: nothing
    fireEvent.keyDown(row('#a'), { key: 'ArrowDown' });
    expect(onReorderChannels).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('#a moved to 2 of 3');
  });

  it('right-click menu: Move up / Move down, and Reset order with a custom order', () => {
    const { row, onReorderChannels, onResetChannelOrder } = renderSidebar({ channelOrder: ['#b', '#a'] });
    fireEvent.contextMenu(row('#a'), { clientX: 10, clientY: 10 });
    const items = Array.from(document.querySelectorAll('.nick-context-menu-item')).map((b) => b.textContent);
    expect(items).toEqual(['Move up', 'Move down', 'Reset order']);
    fireEvent.click(Array.from(document.querySelectorAll('.nick-context-menu-item')).find((b) => b.textContent === 'Move up')!);
    expect(onReorderChannels).toHaveBeenCalledWith(['#a', '#b', '#c']);
    fireEvent.contextMenu(row('#c'), { clientX: 10, clientY: 10 });
    fireEvent.click(Array.from(document.querySelectorAll('.nick-context-menu-item')).find((b) => b.textContent === 'Reset order')!);
    expect(onResetChannelOrder).toHaveBeenCalled();
  });

  it('no Reset order with the default order', () => {
    const { row } = renderSidebar();
    fireEvent.contextMenu(row('#a'), { clientX: 10, clientY: 10 });
    const items = Array.from(document.querySelectorAll('.nick-context-menu-item')).map((b) => b.textContent);
    expect(items).toEqual(['Move down']);
  });

  it('touch: press and hold lifts the row, dragging moves it', () => {
    vi.useFakeTimers();
    const { row, onReorderChannels } = renderSidebar();
    const target = row('#a');
    // Over #c's lower half.
    const prev = document.elementFromPoint;
    document.elementFromPoint = () => row('#c');
    try {
      fireEvent.touchStart(target, { touches: [{ clientX: 50, clientY: 10 }] });
      act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
      expect(row('#a').classList.contains('channel-item-dragging')).toBe(true);
      expect(document.querySelector('.channel-reorder-ghost')?.textContent).toBe('#a');
      fireEvent.touchMove(target, { touches: [{ clientX: 50, clientY: 88 }] });
      expect(row('#c').classList.contains('channel-item-drop-after')).toBe(true);
      fireEvent.touchEnd(target, { touches: [] });
      expect(onReorderChannels).toHaveBeenCalledWith(['#b', '#c', '#a']);
      expect(document.querySelector('.channel-reorder-ghost')).toBeNull();
    } finally {
      document.elementFromPoint = prev;
    }
  });

  it('touch: moving before the hold completes is a scroll, not a drag', () => {
    vi.useFakeTimers();
    const { row, onReorderChannels } = renderSidebar();
    fireEvent.touchStart(row('#a'), { touches: [{ clientX: 50, clientY: 10 }] });
    fireEvent.touchMove(row('#a'), { touches: [{ clientX: 50, clientY: 60 }] });
    act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
    expect(document.querySelector('.channel-item-dragging')).toBeNull();
    fireEvent.touchEnd(row('#a'), { touches: [] });
    expect(onReorderChannels).not.toHaveBeenCalled();
  });

  it('touch: a hold lifted without dragging opens the row sheet', () => {
    vi.useFakeTimers();
    const { row } = renderSidebar();
    fireEvent.touchStart(row('#b'), { touches: [{ clientX: 50, clientY: 40 }] });
    act(() => { vi.advanceTimersByTime(HOLD_MS + 10); });
    fireEvent.touchEnd(row('#b'), { touches: [] });
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.textContent).toContain('Move up');
    expect(sheet?.textContent).toContain('Move down');
  });

  it('does not reorder without onReorderChannels', () => {
    const { rows } = renderSidebar({ onReorderChannels: undefined });
    expect(rows()).toHaveLength(5);
    expect(rows().some((r) => r.hasAttribute('draggable') || r.dataset['reorderKey'])).toBe(false);
  });
});
