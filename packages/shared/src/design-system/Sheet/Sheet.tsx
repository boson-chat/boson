import type { ComponentChildren } from 'preact';
import { useCallback, useLayoutEffect, useRef } from 'preact/hooks';
import { MenuItem } from '../Menu/Menu';
import './Sheet.css';

export interface SheetAction {
  label: string;
  /** True ⇒ render with the danger colour (destructive ops). */
  danger?: boolean;
  /** One of a set of choices (Notifications: All / Mentions / Nothing): shown ticked when true. */
  checked?: boolean;
  onClick: () => void;
}

interface SheetProps {
  /** Accessible name for the dialog. */
  label: string;
  /** Top of the sheet; drags the sheet even when its body scrolls. */
  header: ComponentChildren;
  /** Between the header and the actions. */
  children?: ComponentChildren;
  actions: readonly SheetAction[];
  onClose: () => void;
  /** Filled with the sheet's animated close, for a body that closes it itself (a Select's options). */
  closeRef?: { current: (() => void) | null };
}

// Swipe-to-dismiss: a drag past this share of the sheet's height, or a
// flick faster than this (px/ms), closes it; anything less springs back.
const DISMISS_FRACTION = 0.3;
const DISMISS_VELOCITY = 0.5;
// Movement before a press becomes a drag, so taps on actions still land.
const DRAG_SLOP_PX = 6;
// Matches --motion-medium; the close waits this long if transitionend never
// comes (reduced motion, a hidden tab).
const CLOSE_MS = 220;

// Render it in a portal at document.body (the app's BottomSheet does), so
// no ancestor clips it. (No preact/compat here: importing it changes how
// every onChange in the app behaves.)
//
// The phone layout's menu: slides up from the bottom edge in place of the
// popovers and right-click menus the desktop uses, which have no hover to
// open them and no room beside a full-width row to sit.
//
// It slides in, and slides out on a backdrop tap, Escape, an action, or a
// swipe down. Drag position is written straight to the DOM (no re-render
// per pointer move).
export function Sheet({ label, header, children, actions, onClose, closeRef }: SheetProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const drag = useRef<{ id: number; startY: number; lastY: number; lastT: number; velocity: number; active: boolean } | null>(null);

  // Slide down from wherever the sheet is (rest, or mid-drag), fade the
  // backdrop, then unmount.
  const close = useCallback((): void => {
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (closing.current) return;
    closing.current = true;
    if (!sheet || !backdrop) { onClose(); return; }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      onClose();
    };
    sheet.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, CLOSE_MS + 80);
    sheet.style.transition = `transform var(--motion-medium) var(--ease-in-out)`;
    backdrop.style.transition = `opacity var(--motion-medium) var(--ease-in-out)`;
    sheet.style.transform = 'translateY(100%)';
    backdrop.style.opacity = '0';
  }, [onClose]);
  if (closeRef) closeRef.current = close;

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  // Tall enough to scroll (a long ops menu on a short phone): let the
  // browser pan the body; the handle still drags (see .bds-sheet-scrolls).
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (sheet) sheet.classList.toggle('bds-sheet-scrolls', sheet.scrollHeight > sheet.clientHeight);
  });

  const onPointerDown = (e: PointerEvent): void => {
    const sheet = sheetRef.current;
    if (!sheet || closing.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // A sheet tall enough to scroll keeps its body for scrolling; it is
    // dragged by the grip and header only.
    const scrolls = sheet.scrollHeight > sheet.clientHeight;
    if (scrolls && !(e.target as HTMLElement).closest('.bds-sheet-handle')) return;
    if (scrolls && sheet.scrollTop > 0) return;
    drag.current = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0, active: false };
  };

  const onPointerMove = (e: PointerEvent): void => {
    const d = drag.current;
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (!d || d.id !== e.pointerId || !sheet || !backdrop) return;
    const dy = Math.max(0, e.clientY - d.startY);
    if (!d.active) {
      if (dy < DRAG_SLOP_PX) return;
      d.active = true;
      sheet.setPointerCapture(e.pointerId);
      sheet.style.transition = 'none';
      backdrop.style.transition = 'none';
    }
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.velocity = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    sheet.style.transform = `translateY(${dy}px)`;
    backdrop.style.opacity = String(Math.max(0, 1 - dy / sheet.offsetHeight));
  };

  const onPointerEnd = (e: PointerEvent): void => {
    const d = drag.current;
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.active || !sheet || !backdrop) return;
    const dy = Math.max(0, d.lastY - d.startY);
    if (e.type !== 'pointercancel' && (dy > sheet.offsetHeight * DISMISS_FRACTION || d.velocity > DISMISS_VELOCITY)) {
      close();
      return;
    }
    sheet.style.transition = `transform var(--motion-medium) var(--ease-out)`;
    backdrop.style.transition = `opacity var(--motion-medium) var(--ease-out)`;
    sheet.style.transform = '';
    backdrop.style.opacity = '';
  };

  // A drag that ends over the backdrop fires a click there; it isn't a tap.
  const onBackdropClick = (e: MouseEvent): void => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <div class="bds-sheet-backdrop" ref={backdropRef} onClick={onBackdropClick}>
      <div
        ref={sheetRef}
        class="bds-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div class="bds-sheet-handle">
          <div class="bds-sheet-grip" aria-hidden="true" />
          {header}
        </div>
        {children}
        {actions.length > 0 && (
          <div class="bds-sheet-actions" role="menu">
            {actions.map((a) => (
              <MenuItem key={a.label} size="lg" danger={a.danger} checked={a.checked} onClick={() => { a.onClick(); close(); }}>
                {a.label}
              </MenuItem>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
