import { useRef } from 'preact/hooks';

// How long a finger rests on a message before its menu opens, and how far it
// may wander meanwhile (further is a scroll, not a press).
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

interface Press {
  timer: ReturnType<typeof setTimeout>;
  x: number;
  y: number;
  fired: boolean;
}

/**
 * Touch handlers for a long press, as on Discord's message rows: call the
 * result with what the press does and spread the handlers on the element
 * (one hook serves a whole list; only one finger presses at a time).
 * `enabled` is read when a touch starts, so the desktop layout keeps its own
 * handling. Once the press fires, the touch's click and the native callout /
 * context menu are swallowed so only the press's menu shows.
 */
export function useLongPress(enabled: () => boolean) {
  const press = useRef<Press | null>(null);
  const cancel = (): void => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  return (onLongPress: () => void) => ({
    onTouchStart: (e: TouchEvent): void => {
      cancel();
      const t = e.touches[0];
      if (!t || e.touches.length > 1 || !enabled()) return;
      const p: Press = {
        x: t.clientX,
        y: t.clientY,
        fired: false,
        timer: setTimeout(() => { p.fired = true; onLongPress(); }, LONG_PRESS_MS),
      };
      press.current = p;
    },
    onTouchMove: (e: TouchEvent): void => {
      const p = press.current;
      const t = e.touches[0];
      if (!p || p.fired || !t) return;
      if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onTouchEnd: (e: TouchEvent): void => {
      if (press.current?.fired && e.cancelable) e.preventDefault();
      cancel();
    },
    onTouchCancel: cancel,
    onContextMenu: (e: MouseEvent): void => {
      // Android raises contextmenu on a long press; the sheet replaces it.
      if (enabled()) e.preventDefault();
    },
  });
}
