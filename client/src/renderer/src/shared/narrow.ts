import { useEffect, useState } from 'preact/hooks';
import { NARROW_QUERY } from '@boson/shared';
import { titleBarYields } from './window-controls';

// The phone layout's breakpoint (see @boson/shared): the chat layout shows
// one pane at a time below it.
export { NARROW_QUERY };

/** The same, read once — for event handlers that only need it at the time. */
export function isNarrow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(NARROW_QUERY).matches;
}

/** True while the viewport is phone-narrow; follows rotation and resizes. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/**
 * The phone layout without the top bar (the iOS / Android app, the web build
 * at phone width; titleBarYields): each screen's own header clears the
 * status bar, the bell is in the server rail under your avatar, and settings
 * are in My space. A narrow desktop window keeps its title bar.
 */
export function useNoTitleBar(): boolean {
  return useNarrow() && titleBarYields();
}

/**
 * A phone's touch keyboard (not a desktop's, or a narrow desktop window):
 * Return there inserts a newline and the Send button sends, as in other
 * mobile chat apps.
 */
export function isTouchPhone(): boolean {
  if (!isNarrow()) return false;
  const platform = typeof window !== 'undefined' ? (window as { bosonPlatform?: string }).bosonPlatform : undefined;
  if (platform === 'ios' || platform === 'android') return true;
  return window.matchMedia('(pointer: coarse)').matches;
}

// Tablets in portrait and narrow desktop windows (701-1023px; an iPad in
// landscape, 1024, keeps the columns): wider than a phone, too
// narrow for rail + channels + chat + members side by side. The member list
// (and the call panel) open as an overlay there instead.
export const MID_QUERY = '(min-width: 701px) and (max-width: 1023px)';

/** True while the viewport is mid-width (and not phone-narrow). */
export function useMid(): boolean {
  const query = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(MID_QUERY).matches && !window.matchMedia(NARROW_QUERY).matches;
  const [mid, setMid] = useState(query);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mqs = [window.matchMedia(MID_QUERY), window.matchMedia(NARROW_QUERY)];
    const onChange = (): void => setMid(query());
    onChange();
    for (const mq of mqs) mq.addEventListener('change', onChange);
    return () => { for (const mq of mqs) mq.removeEventListener('change', onChange); };
  }, []);
  return mid;
}
