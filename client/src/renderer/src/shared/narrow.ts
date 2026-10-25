import { useEffect, useState } from 'preact/hooks';

// A phone, or any window too narrow for the side-by-side layout (server
// rail, channels, chat and members): the chat layout shows one pane at a
// time below this width. Tablets and desktop windows keep the full layout.
export const NARROW_QUERY = '(max-width: 700px)';

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
