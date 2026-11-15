import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { channelKey, moveChannel, stepChannel, type ChannelDrop } from '../../modules/session/channel-order';

// Drag to reorder the sidebar's channel list, within a section (channels,
// direct messages). Three ways in:
//   - mouse: HTML5 drag and drop, like the server rail;
//   - touch: press and hold a row (so a plain swipe still scrolls), then
//     drag it; lifting without moving opens the row's menu instead;
//   - keyboard: Alt+Up / Alt+Down on a focused row (and Move up / down in
//     the row's menu).
// Rows stay put while dragging; a line shows where the row will land.

export type ReorderSection = 'channels' | 'dms';

// How long a finger rests on a row before it lifts for dragging, and how
// far it may wander meanwhile (further is a scroll).
export const HOLD_MS = 400;
const HOLD_TOLERANCE_PX = 10;
// While a finger drags near the list's top / bottom edge, scroll it.
const EDGE_PX = 40;
const EDGE_STEP_PX = 12;

interface Drag { name: string; section: ReorderSection }

interface Touch {
  name: string;
  section: ReorderSection;
  x0: number;
  y0: number;
  timer: ReturnType<typeof setTimeout> | null;
  lifted: boolean;
  moved: boolean;
}

export interface ReorderOptions {
  /** Off: rows don't drag and the keys do nothing (e.g. while searching). */
  enabled: boolean;
  /** Each section's names as shown, top to bottom. */
  sections: Record<ReorderSection, readonly string[]>;
  /** A section's names in their new order, after a move. */
  onReorder: (section: ReorderSection, names: string[]) => void;
  /** A touch press and hold that was lifted without dragging. */
  onHold?: (name: string, section: ReorderSection) => void;
}

// Coarse pointers (phones, tablets) use the press-and-hold drag; native
// HTML5 drag there would fight it.
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

function rowAt(x: number, y: number): HTMLElement | null {
  if (typeof document.elementFromPoint !== 'function') return null;
  const el = document.elementFromPoint(x, y);
  return (el?.closest('[data-reorder-key]') as HTMLElement | null) ?? null;
}

export function useChannelReorder({ enabled, sections, onReorder, onHold }: ReorderOptions) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<ChannelDrop | null>(null);
  // Where the finger is while a touch drag is on (the floating label).
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  // Screen-reader note after a move ("#a moved to 2 of 5").
  const [announce, setAnnounce] = useState('');
  const touch = useRef<Touch | null>(null);
  // Live copies for the touch handlers (a gesture outlives one render).
  const live = useRef({ drop, sections, onReorder, onHold });
  live.current = { drop, sections, onReorder, onHold };
  // A keyboard move: focus follows the row once it has re-rendered.
  // Waits for the row to reach its new place: the new order comes back
  // through the parent, maybe a render or two later.
  const refocus = useRef<{ key: string; section: ReorderSection; at: number } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const want = refocus.current;
    if (!want || !listRef.current) return;
    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>(
      `[data-reorder-section="${want.section}"]`,
    ));
    const i = rows.findIndex((el) => el.dataset['reorderKey'] === want.key);
    if (i === -1) { refocus.current = null; return; }
    if (i !== want.at) return;
    refocus.current = null;
    if (document.activeElement !== rows[i]) rows[i]!.focus();
  });

  const end = (): void => {
    setDrag(null);
    setDrop(null);
    setGhost(null);
  };

  const commit = (section: ReorderSection, dragged: string, at: ChannelDrop | null): boolean => {
    const names = live.current.sections[section];
    if (!at) return false;
    const next = moveChannel(names, dragged, at);
    if (next.every((n, i) => n === names[i])) return false;
    live.current.onReorder(section, next);
    const pos = next.findIndex((n) => channelKey(n) === channelKey(dragged)) + 1;
    setAnnounce(`${dragged} moved to ${pos} of ${next.length}`);
    return true;
  };

  /** Move a row one place up / down (keyboard, menu). */
  const step = (name: string, section: ReorderSection, delta: -1 | 1, focus = false): void => {
    const names = sections[section];
    const next = stepChannel(names, name, delta);
    if (next.every((n, i) => n === names[i])) return;
    const pos = next.findIndex((n) => channelKey(n) === channelKey(name)) + 1;
    if (focus) refocus.current = { key: channelKey(name), section, at: pos - 1 };
    onReorder(section, next);
    setAnnounce(`${name} moved to ${pos} of ${next.length}`);
  };

  // A finger over (x, y): the row it would land beside, if in its section.
  const aim = (x: number, y: number): void => {
    const t = touch.current;
    if (!t) return;
    const row = rowAt(x, y);
    if (!row || row.dataset['reorderSection'] !== t.section) return;
    const target = row.dataset['reorderName']!;
    const r = row.getBoundingClientRect();
    const after = y > r.top + r.height / 2;
    const cur = live.current.drop;
    if (cur?.target !== target || cur.after !== after) setDrop({ target, after });
  };

  const edgeScroll = (y: number): void => {
    const list = listRef.current;
    if (!list) return;
    const r = list.getBoundingClientRect();
    if (y < r.top + EDGE_PX) list.scrollTop -= EDGE_STEP_PX;
    else if (y > r.bottom - EDGE_PX) list.scrollTop += EDGE_STEP_PX;
  };

  const cancelTouch = (): void => {
    const t = touch.current;
    if (t?.timer) clearTimeout(t.timer);
    touch.current = null;
  };

  /** Attributes and handlers for one row. */
  const row = (name: string, section: ReorderSection) => {
    const key = channelKey(name);
    const base = {
      'data-reorder-key': key,
      'data-reorder-name': name,
      'data-reorder-section': section,
    };
    if (!enabled) return base;
    const native = !coarsePointer();
    return {
      ...base,
      draggable: native,
      onDragStart: native ? (e: DragEvent): void => {
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/x-boson-channel', name);
        }
        setDrag({ name, section });
      } : undefined,
      onDragOver: (e: DragEvent): void => {
        if (!drag || drag.section !== section) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        if (drop?.target !== name || drop.after !== after) setDrop({ target: name, after });
      },
      onDragEnd: end,
      onTouchStart: (e: TouchEvent): void => {
        cancelTouch();
        const p = e.touches[0];
        if (!p || e.touches.length > 1) return;
        const t: Touch = { name, section, x0: p.clientX, y0: p.clientY, timer: null, lifted: false, moved: false };
        t.timer = setTimeout(() => {
          t.timer = null;
          t.lifted = true;
          setDrag({ name, section });
          setDrop(null);
          setGhost({ x: t.x0, y: t.y0 });
          try { navigator.vibrate?.(10); } catch { /* not supported */ }
        }, HOLD_MS);
        touch.current = t;
      },
      onTouchMove: (e: TouchEvent): void => {
        const t = touch.current;
        const p = e.touches[0];
        if (!t || !p) return;
        if (!t.lifted) {
          // Moving before the hold completes is a scroll: let it be.
          if (Math.hypot(p.clientX - t.x0, p.clientY - t.y0) > HOLD_TOLERANCE_PX) cancelTouch();
          return;
        }
        // Lifted: this finger drags the row, not the list or the drawers.
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (Math.abs(p.clientY - t.y0) > HOLD_TOLERANCE_PX / 2) t.moved = true;
        setGhost({ x: p.clientX, y: p.clientY });
        edgeScroll(p.clientY);
        aim(p.clientX, p.clientY);
      },
      onTouchEnd: (e: TouchEvent): void => {
        const t = touch.current;
        cancelTouch();
        if (!t?.lifted) return;
        // The touch's click would select the channel: swallow it.
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        const moved = t.moved && commit(t.section, t.name, live.current.drop);
        end();
        if (!t.moved && !moved) live.current.onHold?.(t.name, t.section);
      },
      onTouchCancel: (): void => {
        const lifted = touch.current?.lifted;
        cancelTouch();
        if (lifted) end();
      },
      /** True when the key was a reorder key (the row ignores it then). */
      onReorderKey: (e: KeyboardEvent): boolean => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false;
        e.preventDefault();
        step(name, section, e.key === 'ArrowUp' ? -1 : 1, true);
        return true;
      },
    };
  };

  /** The drop line on a row: shown above the row below the landing spot,
   *  so it sits under any voice rooms listed beneath a channel. */
  const indicator = (name: string, section: ReorderSection): 'before' | 'after' | null => {
    if (!drag || !drop || drag.section !== section) return null;
    const names = sections[section];
    const ti = names.findIndex((n) => channelKey(n) === channelKey(drop.target));
    if (ti === -1) return null;
    const slot = drop.after ? ti + 1 : ti; // index the row would take before removal
    const di = names.findIndex((n) => channelKey(n) === channelKey(drag.name));
    if (slot === di || slot === di + 1) return null; // back where it was
    const i = names.findIndex((n) => channelKey(n) === channelKey(name));
    if (slot < names.length) return i === slot ? 'before' : null;
    return i === names.length - 1 ? 'after' : null;
  };

  // Mouse drags between rows (voice rooms, headers): keep the move cursor
  // and drop where the line is.
  const list = {
    ref: listRef,
    onDragOver: (e: DragEvent): void => {
      if (!drag) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    },
    onDrop: (e: DragEvent): void => {
      if (!drag) return;
      e.preventDefault();
      commit(drag.section, drag.name, drop);
      end();
    },
  };

  return { drag, ghost, announce, row, indicator, list, step };
}
