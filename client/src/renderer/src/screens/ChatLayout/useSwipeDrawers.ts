import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

// The phone layout's drawers, Discord style: the chat is the top surface;
// swiping it right slides it aside to reveal the server rail and channel
// list underneath, swiping it left reveals the member list. A sliver of
// the chat (PEEK px) stays on screen; tapping or swiping it back closes.
export type Drawer = 'none' | 'nav' | 'members';

/** Width of the chat sliver left showing while a drawer is open. */
export const PEEK = 56;
// A horizontal gesture is decided once the finger has moved this far, and
// mostly sideways; vertical ones are left to the message list's scrolling.
const DECIDE_PX = 10;
const HORIZONTAL_BIAS = 1.2;
// Release: open/close past this share of the drawer, or on a flick.
const OPEN_SHARE = 0.35;
const FLICK_PX_PER_MS = 0.35;

export interface SwipeDrawers {
  drawer: Drawer;
  setDrawer: (d: Drawer) => void;
  /** Live offset of the chat surface while a finger drags it (px), else null. */
  dragX: number | null;
  /** Which drawer the surface currently shows (also while dragging). */
  reveal: Exclude<Drawer, 'none'> | null;
}

// Touches that must stay with their target: text entry, and anything that
// scrolls sideways itself (code blocks, tab strips, wide tables).
function keepsTouch(target: EventTarget | null, root: HTMLElement): boolean {
  for (let el = target as HTMLElement | null; el && el !== root; el = el.parentElement) {
    if (el.matches?.('input, textarea, select, [contenteditable="true"], [data-no-swipe]')) return true;
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

/**
 * Swipe handling for the phone layout's drawers, on `rootRef` (the app
 * shell). `enabled` is false on wide layouts; `canMembers` says whether
 * there's a member list to reveal (a channel, not a DM).
 */
export function useSwipeDrawers(
  rootRef: RefObject<HTMLElement>, enabled: boolean, initial: Drawer, canMembers: boolean,
): SwipeDrawers {
  const [drawer, setDrawer] = useState<Drawer>(initial);
  const [dragX, setDragX] = useState<number | null>(null);
  const [dragReveal, setDragReveal] = useState<Exclude<Drawer, 'none'> | null>(null);
  // The handlers below are attached once; they read the latest values here.
  const live = useRef({ drawer, canMembers });
  live.current = { drawer, canMembers };

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    let g: {
      x0: number; y0: number; t0: number; base: number; width: number;
      mode: 'pending' | 'h' | 'v'; x: number;
    } | null = null;

    const baseFor = (d: Drawer, width: number): number =>
      d === 'nav' ? width - PEEK : d === 'members' ? -(width - PEEK) : 0;

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || keepsTouch(e.target, root)) { g = null; return; }
      const t = e.touches[0]!;
      const width = root.clientWidth;
      g = { x0: t.clientX, y0: t.clientY, t0: e.timeStamp, base: baseFor(live.current.drawer, width), width, mode: 'pending', x: 0 };
    };

    const onMove = (e: TouchEvent): void => {
      if (!g) return;
      const t = e.touches[0]!;
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (g.mode === 'pending') {
        if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
        g.mode = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_BIAS ? 'h' : 'v';
      }
      if (g.mode !== 'h') return;
      const span = g.width - PEEK;
      // From closed, the direction picks the drawer; an open drawer only
      // slides between open and closed.
      const d = live.current.drawer;
      let min = 0;
      let max = 0;
      if (d === 'nav') { min = 0; max = span; } else if (d === 'members') { min = -span; max = 0; } else {
        max = span;
        min = live.current.canMembers ? -span : 0;
      }
      const x = Math.max(min, Math.min(max, g.base + dx));
      if (x === 0 && g.base === 0) return; // nothing to reveal that way
      e.preventDefault();
      g.x = x;
      setDragX(x);
      setDragReveal(x > 0 ? 'nav' : x < 0 ? 'members' : null);
    };

    const onEnd = (e: TouchEvent): void => {
      if (!g || g.mode !== 'h') { g = null; return; }
      const span = g.width - PEEK;
      const v = (g.x - g.base) / Math.max(1, e.timeStamp - g.t0);
      const d = live.current.drawer;
      let next: Drawer = d;
      if (d === 'none') {
        if (g.x > 0 && (g.x > span * OPEN_SHARE || v > FLICK_PX_PER_MS)) next = 'nav';
        else if (g.x < 0 && (-g.x > span * OPEN_SHARE || v < -FLICK_PX_PER_MS)) next = 'members';
      } else if (d === 'nav') {
        if (g.x < span * (1 - OPEN_SHARE) || v < -FLICK_PX_PER_MS) next = 'none';
      } else if (-g.x < span * (1 - OPEN_SHARE) || v > FLICK_PX_PER_MS) {
        next = 'none';
      }
      g = null;
      setDrawer(next);
      setDragX(null);
      setDragReveal(null);
    };

    root.addEventListener('touchstart', onStart, { passive: true });
    // Not passive: a horizontal drag cancels the browser's own handling.
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onEnd);
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, rootRef]);

  const reveal = dragX !== null ? dragReveal : drawer === 'none' ? null : drawer;
  return { drawer, setDrawer, dragX, reveal };
}
