import { useEffect } from 'preact/hooks';
import { useLocation } from 'preact-iso';

/**
 * Page-transition wiring. Two layers:
 *
 *   1. Intercept every same-origin anchor click, and run the route
 *      change inside `document.startViewTransition(...)`. Browsers that
 *      support the View Transitions API (Chrome 111+, Safari 18+) get
 *      a smooth crossfade between pages — for free, no per-page work.
 *
 *   2. Browsers without that API see a CSS-only entrance animation on
 *      each route mount instead (see styles.css `.route-content`). The
 *      old page just pops out, the new one fades + slides up.
 *
 * preact-iso owns anchor-click handling internally. We pre-empt it by
 * catching the bubbling `click` at the document level (capture phase
 * is too eager; preact-iso wants to see the event flow normally) and
 * call its `route()` from inside the transition callback.
 */
// Narrow shape of the VT API we actually use — keeps us decoupled
// from whichever TS lib version is in effect (it's been in lib.dom.d.ts
// only since TS 5.4, and even then the signature has shifted).
type StartViewTransition = (cb: () => void | Promise<void>) => unknown;

export function usePageTransitions(): void {
  const { route } = useLocation();

  useEffect(() => {
    const start = (document as unknown as { startViewTransition?: StartViewTransition })
      .startViewTransition;
    if (typeof start !== 'function') return;

    const handler = (event: MouseEvent) => {
      // Ignore everything that wouldn't have triggered a navigation
      // anyway — modifier-clicks, middle/right buttons, default-
      // prevented (preact-iso already handled it), etc.
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target as Element | null;
      if (!target) return;
      const anchor = target.closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      const targetAttr = anchor.getAttribute('target');
      if (targetAttr && targetAttr !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      // External link → let the browser handle it normally.
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same page (just a hash or identical pathname) — no transition.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      // Take over: stop preact-iso's own handler, run the route change
      // inside startViewTransition so the crossfade fires.
      event.preventDefault();
      const path = url.pathname + url.search + url.hash;
      start(() => {
        route(path);
      });
    };

    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [route]);
}
