import type { RefObject } from 'preact';
import { useLayoutEffect } from 'preact/hooks';

// When a list mounts (a phone swipe back to the channel list builds it
// afresh), scroll it so the row you're on shows, centred, instead of always
// starting at the top. Only the list itself scrolls: no scrollIntoView, which
// would also scroll the page around it.
export function revealCurrent(list: HTMLElement | null | undefined, selector: string): void {
  if (!list) return;
  const row = list.querySelector<HTMLElement>(selector);
  if (!row) return;
  const box = list.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top >= box.top && r.bottom <= box.bottom) return;
  const top = list.scrollTop + (r.top - box.top) - (box.height - r.height) / 2;
  list.scrollTop = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight));
}

// Once, on mount: `root` holds the scrolling list (`listSelector`, or root
// itself) and the current row (`rowSelector`).
export function useRevealCurrent(root: RefObject<HTMLElement>, listSelector: string, rowSelector: string): void {
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    revealCurrent(el.matches(listSelector) ? el : el.querySelector<HTMLElement>(listSelector), rowSelector);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
