import { useEffect, useState } from 'preact/hooks';

// A phone, or any window too narrow for the side-by-side layout (server
// rail, channels, chat and members): the chat layout shows one pane at a
// time below this width. Tablets and desktop windows keep the full layout.
// A phone turned on its side is wider than that but much shorter: it keeps
// the phone layout too (a touch screen under 500px tall). Keep in step with
// the CSS @media queries that use the same breakpoint.
export const NARROW_QUERY = '(max-width: 700px), (max-height: 500px) and (pointer: coarse)';

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
