import { useEffect, useState } from 'preact/hooks';
import { NARROW_QUERY } from '@boson/shared';

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
