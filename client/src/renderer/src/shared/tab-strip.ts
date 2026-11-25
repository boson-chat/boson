import { useEffect, useRef } from 'preact/hooks';

// A settings menu that turns into a sideways-scrolling strip of tabs on a
// phone (User settings, Server settings). Keeps the selected tab in view with
// `pad` px to spare (opening on the last section lands at the strip's end),
// and marks which edges have more tabs past them for the CSS edge fade.

// Scroll `nav` so `tab` shows with `pad` px clear of either edge. Only the
// strip scrolls: no scrollIntoView, which would also scroll the page.
export function revealTab(nav: HTMLElement, tab: HTMLElement, pad = 24): void {
  if (nav.scrollWidth <= nav.clientWidth) return;
  const left = tab.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
  const max = nav.scrollWidth - nav.clientWidth;
  if (left < nav.scrollLeft + pad) nav.scrollLeft = Math.max(0, left - pad);
  else if (left + tab.offsetWidth > nav.scrollLeft + nav.clientWidth - pad) {
    nav.scrollLeft = Math.min(max, left + tab.offsetWidth - nav.clientWidth + pad);
  }
}

export function markStripEdges(nav: HTMLElement): void {
  const max = nav.scrollWidth - nav.clientWidth;
  nav.toggleAttribute('data-more-start', max > 1 && nav.scrollLeft > 1);
  nav.toggleAttribute('data-more-end', max > 1 && nav.scrollLeft < max - 1);
}

// `deps` re-reveal the selected tab (`selector`) when they change.
export function useTabStrip<T extends HTMLElement>(
  deps: ReadonlyArray<unknown>,
  selector = '.bds-row-selected',
): { ref: { current: T | null }; onScroll: () => void } {
  const ref = useRef<T>(null);
  const onScroll = (): void => {
    if (ref.current) markStripEdges(ref.current);
  };
  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const tab = nav.querySelector<HTMLElement>(selector);
    if (tab) revealTab(nav, tab);
    markStripEdges(nav);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ref, onScroll };
}
