import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/preact';
import { useLongPress } from './long-press';

function Pressable({ enabled, onLongPress }: { enabled: () => boolean; onLongPress: () => void }) {
  const longPress = useLongPress(enabled);
  return <div class="target" {...longPress(onLongPress)}>row</div>;
}

function setup(enabled = true) {
  const onLongPress = vi.fn();
  render(<Pressable enabled={() => enabled} onLongPress={onLongPress} />);
  return { el: document.querySelector('.target')!, onLongPress };
}

function touchStart(el: Element, x = 10, y = 10, fingers = 1): void {
  fireEvent.touchStart(el, { touches: Array.from({ length: fingers }, () => ({ clientX: x, clientY: y })) });
}

function wait(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useLongPress', () => {
  it('fires after the finger rests for 450ms', () => {
    const { el, onLongPress } = setup();
    touchStart(el);
    wait(449);
    expect(onLongPress).not.toHaveBeenCalled();
    wait(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('not when the finger lifts first', () => {
    const { el, onLongPress } = setup();
    touchStart(el);
    wait(300);
    fireEvent.touchEnd(el, { touches: [] });
    wait(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('tolerates a small wobble but not a scroll', () => {
    const { el, onLongPress } = setup();
    touchStart(el);
    fireEvent.touchMove(el, { touches: [{ clientX: 16, clientY: 16 }] });
    wait(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    touchStart(el);
    fireEvent.touchMove(el, { touches: [{ clientX: 10, clientY: 25 }] });
    wait(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('not for a two-finger touch, or a cancelled one', () => {
    const { el, onLongPress } = setup();
    touchStart(el, 10, 10, 2);
    wait(500);
    touchStart(el);
    fireEvent.touchCancel(el);
    wait(500);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('swallows the touch end after it fires, so no click follows', () => {
    const { el } = setup();
    touchStart(el);
    wait(500);
    const end = new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] });
    el.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true);

    touchStart(el);
    wait(100);
    const tap = new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [] });
    el.dispatchEvent(tap);
    expect(tap.defaultPrevented).toBe(false);
  });

  it('suppresses the native context menu only when enabled', () => {
    const on = setup(true);
    expect(fireEvent.contextMenu(on.el)).toBe(false);
    document.body.innerHTML = '';
    const off = setup(false);
    expect(fireEvent.contextMenu(off.el)).toBe(true);
  });

  it('does nothing when disabled (the desktop layout)', () => {
    const { el, onLongPress } = setup(false);
    touchStart(el);
    wait(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
