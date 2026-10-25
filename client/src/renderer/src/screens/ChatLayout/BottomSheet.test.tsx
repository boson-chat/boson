import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import { BottomSheet } from './BottomSheet';

// The sheet unmounts on transitionend, or after this fallback when none
// comes (as in happy-dom).
const CLOSE_WAIT_MS = 400;
const SHEET_HEIGHT = 300;

function renderSheet(onClose = vi.fn(), onAction = vi.fn()) {
  render(
    <BottomSheet
      label="alice"
      header={<div class="test-header">alice</div>}
      actions={[{ label: 'Message alice', onClick: onAction }]}
      onClose={onClose}
    >
      <p class="test-body">body</p>
    </BottomSheet>,
  );
  const sheet = screen.getByRole('dialog', { name: 'alice' }) as HTMLElement;
  Object.defineProperty(sheet, 'offsetHeight', { configurable: true, value: SHEET_HEIGHT });
  sheet.setPointerCapture = () => {};
  return { sheet, onClose, onAction };
}

function settle(): void {
  act(() => { vi.advanceTimersByTime(CLOSE_WAIT_MS); });
}

// A touch pointer event at `clientY`, stamped `timeStamp` (happy-dom
// ignores a timeStamp in the init, and the flick speed is read from it).
function pointer(el: Element, type: string, clientY: number, timeStamp: number, init: PointerEventInit = {}): void {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientY, ...init });
  Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  act(() => { el.dispatchEvent(e); });
}

// A one-finger drag from y=100 down by `dy`, `ms` long in all.
function drag(sheet: HTMLElement, dy: number, ms: number, end: 'pointerup' | 'pointercancel' = 'pointerup'): void {
  const t0 = 1000;
  pointer(sheet, 'pointerdown', 100, t0);
  pointer(sheet, 'pointermove', 100 + dy / 2, t0 + ms / 2);
  pointer(sheet, 'pointermove', 100 + dy, t0 + ms);
  pointer(sheet, end, 100 + dy, t0 + ms);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  document.body.querySelectorAll('.bottom-sheet-backdrop').forEach((n) => n.remove());
});

describe('BottomSheet', () => {
  it('renders the header, body and actions in a portal on <body>', () => {
    const { sheet } = renderSheet();
    expect(sheet.parentElement?.parentElement).toBe(document.body);
    expect(sheet.querySelector('.bottom-sheet-handle .test-header')).not.toBeNull();
    expect(sheet.querySelector('.test-body')).not.toBeNull();
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Message alice']);
  });

  it('runs an action, then slides out and closes', () => {
    const { sheet, onClose, onAction } = renderSheet();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Message alice' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(sheet.style.transform).toBe('translateY(100%)');
    expect(onClose).not.toHaveBeenCalled();
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on transitionend without waiting for the fallback', () => {
    const { sheet, onClose } = renderSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent(sheet, new Event('transitionend'));
    expect(onClose).toHaveBeenCalledTimes(1);
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a backdrop tap, not on a tap inside the sheet', () => {
    const { sheet, onClose } = renderSheet();
    fireEvent.click(sheet.querySelector('.test-body')!);
    settle();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.bottom-sheet-backdrop')!);
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('follows the finger while dragged down', () => {
    const { sheet } = renderSheet();
    pointer(sheet, 'pointerdown', 100, 0);
    pointer(sheet, 'pointermove', 160, 500);
    expect(sheet.style.transform).toBe('translateY(60px)');
    // Dragging up past the start doesn't lift it.
    pointer(sheet, 'pointermove', 40, 1000);
    expect(sheet.style.transform).toBe('translateY(0px)');
  });

  it('dismisses a slow swipe past 30% of its height', () => {
    const { sheet, onClose } = renderSheet();
    drag(sheet, SHEET_HEIGHT * 0.5, 1000); // 0.15 px/ms
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses a short, fast flick', () => {
    const { sheet, onClose } = renderSheet();
    drag(sheet, 40, 40); // 1 px/ms
    settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('springs back from a short, slow drag', () => {
    const { sheet, onClose } = renderSheet();
    drag(sheet, 40, 1000); // 0.04 px/ms
    expect(sheet.style.transform).toBe('');
    settle();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('springs back when the gesture is cancelled', () => {
    const { sheet, onClose } = renderSheet();
    drag(sheet, SHEET_HEIGHT, 1000, 'pointercancel');
    expect(sheet.style.transform).toBe('');
    settle();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a wobble under the drag slop is still a tap on an action', () => {
    const { sheet, onAction } = renderSheet();
    const action = screen.getByRole('menuitem', { name: 'Message alice' });
    pointer(action, 'pointerdown', 100, 0);
    pointer(action, 'pointermove', 104, 50);
    pointer(action, 'pointerup', 104, 60);
    expect(sheet.style.transform).toBe('');
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('ignores a right-button mouse press', () => {
    const { sheet } = renderSheet();
    pointer(sheet, 'pointerdown', 100, 0, { pointerType: 'mouse', button: 2 });
    pointer(sheet, 'pointermove', 200, 500, { pointerType: 'mouse' });
    expect(sheet.style.transform).toBe('');
  });
});
