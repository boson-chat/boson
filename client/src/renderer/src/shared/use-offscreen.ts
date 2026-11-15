import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';

// Calls onHidden when the element scrolls out of the message list's view
// (or the window's, outside one): players pause, a framed YouTube player is
// unloaded. Rows far off screen leave the DOM altogether (the windowed
// list); this covers the ones still in it, just above or below.
export function useOffscreen(ref: RefObject<Element>, onHidden: () => void, enabled = true): void {
  const cb = useRef(onHidden);
  cb.current = onHidden;
  const watching = useRef<{ el: Element; io: IntersectionObserver } | null>(null);
  // After every render: (re)watch whatever element the ref holds now (a
  // player appears once its embed is loaded).
  useEffect(() => {
    const el = enabled ? ref.current : null;
    if (watching.current?.el === el) return;
    watching.current?.io.disconnect();
    watching.current = null;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (!e.isIntersecting) cb.current();
    }, { root: el.closest('.chat-messages'), threshold: 0 });
    io.observe(el);
    watching.current = { el, io };
  });
  useEffect(() => () => { watching.current?.io.disconnect(); watching.current = null; }, []);
}

// A media element: paused when it scrolls away.
export function usePauseOffscreen(ref: RefObject<HTMLMediaElement>): void {
  useOffscreen(ref, () => { const m = ref.current; if (m && !m.paused) m.pause(); });
}
