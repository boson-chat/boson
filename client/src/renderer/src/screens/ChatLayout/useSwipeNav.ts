import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

// Phones: swipe between the screens. On a conversation, swipe right for the
// channel list and left for its members; on the channel list, left for the
// conversation; on any other page, right goes back. The screen follows the
// finger, the one it leads to shows underneath, and letting go past a
// third of the width (or with a flick) goes there.

// A horizontal gesture is decided once the finger has moved this far, and
// mostly sideways; vertical ones are left to the lists' scrolling.
const DECIDE_PX = 10;
const HORIZONTAL_BIAS = 1.2;
const GO_SHARE = 0.33;
const FLICK_PX_PER_MS = 0.35;
// The slide out after letting go (none under reduced motion).
export const SETTLE_MS = 180;

export interface SwipeNav {
  /** The current screen's offset while dragged or settling (px), else null. */
  dx: number | null;
  /** Which way it's being dragged: to `back` (right) or `forward` (left). */
  dir: 'back' | 'forward' | null;
  /** Letting go: the slide out is running. */
  settling: boolean;
}

// Touches that must stay with their target: text entry, and anything that
// scrolls sideways itself (code blocks, tab strips, wide tables).
function keepsTouch(target: EventTarget | null, root: HTMLElement): boolean {
  for (let el = target as HTMLElement | null; el && el !== root; el = el.parentElement) {
    if (el.matches?.('input, textarea, select, [contenteditable="true"], [data-no-swipe]')) return true;
    // (A few pixels of overflow, as a vertical list can have, isn't a
    // sideways scroller.)
    if (el.scrollWidth > el.clientWidth + 8) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Swipe navigation on `rootRef` (the phone's screen). `canBack` / `canForward`
 * say whether there's somewhere to go each way; `go` goes there.
 */
export function useSwipeNav(
  rootRef: RefObject<HTMLElement>,
  enabled: boolean,
  canBack: boolean,
  canForward: boolean,
  go: (dir: 'back' | 'forward') => void,
): SwipeNav {
  const [state, setState] = useState<SwipeNav>({ dx: null, dir: null, settling: false });
  const live = useRef({ canBack, canForward, go });
  live.current = { canBack, canForward, go };

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return;
    let g: { x0: number; y0: number; t0: number; width: number; mode: 'pending' | 'h' | 'v'; x: number } | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;

    const onStart = (e: TouchEvent): void => {
      if (settle || e.touches.length !== 1 || keepsTouch(e.target, root)) { g = null; return; }
      const t = e.touches[0]!;
      g = { x0: t.clientX, y0: t.clientY, t0: e.timeStamp, width: root.clientWidth, mode: 'pending', x: 0 };
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
      const { canBack: b, canForward: f } = live.current;
      const x = Math.max(f ? -g.width : 0, Math.min(b ? g.width : 0, dx));
      if (x === 0 && g.x === 0) return; // nowhere to go that way
      e.preventDefault();
      g.x = x;
      setState({ dx: x, dir: x > 0 ? 'back' : x < 0 ? 'forward' : null, settling: false });
    };

    const onEnd = (e: TouchEvent): void => {
      if (!g || g.mode !== 'h') { g = null; return; }
      const { x, width, t0 } = g;
      g = null;
      const v = x / Math.max(1, e.timeStamp - t0);
      const dir = x > 0 ? 'back' : 'forward';
      const goes = x !== 0 && (Math.abs(x) > width * GO_SHARE || Math.abs(v) > FLICK_PX_PER_MS) && Math.sign(v || x) === Math.sign(x);
      if (!goes) { setState({ dx: null, dir: null, settling: false }); return; }
      if (reducedMotion()) { live.current.go(dir); setState({ dx: null, dir: null, settling: false }); return; }
      setState({ dx: x > 0 ? width : -width, dir, settling: true });
      settle = setTimeout(() => {
        settle = null;
        live.current.go(dir);
        setState({ dx: null, dir: null, settling: false });
      }, SETTLE_MS);
    };

    root.addEventListener('touchstart', onStart, { passive: true });
    // Not passive: a horizontal drag cancels the browser's own handling.
    root.addEventListener('touchmove', onMove, { passive: false });
    root.addEventListener('touchend', onEnd);
    root.addEventListener('touchcancel', onEnd);
    return () => {
      if (settle) clearTimeout(settle);
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, rootRef]);

  return state;
}
