// The on-screen keyboard. On iOS (WKWebView, Safari) the keyboard doesn't
// resize the page: it covers the bottom of it and only the visual viewport
// shrinks, and WebKit then scrolls the whole page up to show the focused
// field — the header slides off the top and the newest messages sit under
// the keyboard. Android's shell resizes the webview (adjustResize), which
// this also follows.
//
// On touch screens, keep the app exactly the size of what's visible:
//   --app-height  the visual viewport's height (the app's #app height),
//   html.kb-open  while a keyboard covers part of the screen (the home
//                 indicator's safe-area padding then isn't needed),
// and undo the page scroll WebKit adds, so the composer sits right on top
// of the keyboard and the header stays put. Desktop (fine pointers) is left
// alone.

/** Shrinks smaller than this are browser chrome, not a keyboard. */
export const KEYBOARD_MIN_PX = 120;

interface VV extends EventTarget {
  readonly height: number;
  readonly offsetTop: number;
}

export interface ViewportEnv {
  root: HTMLElement;
  vv: VV;
  /** The layout viewport's height (window.innerHeight). */
  layoutHeight: () => number;
  scrollY: () => number;
  scrollTo: (y: number) => void;
}

/** Applies the visual viewport to `env.root` once (exported for tests). */
export function applyViewport(env: ViewportEnv, baseline: number): void {
  const { root, vv } = env;
  const height = Math.round(vv.height);
  root.style.setProperty('--app-height', `${height}px`);
  root.classList.toggle('kb-open', baseline - height >= KEYBOARD_MIN_PX);
  // WebKit scrolled the page to reveal the focused field: the app already
  // fits above the keyboard, so put the page back.
  if (env.scrollY() !== 0) env.scrollTo(0);
  // Still panned (the visual viewport moved within the layout viewport,
  // which a page scroll can't undo): follow it.
  const top = Math.round(vv.offsetTop);
  root.style.setProperty('--app-top', `${top > 0 ? top : 0}px`);
}

/** Whether this device gets the keyboard handling: a touch screen. */
export function wantsViewportTracking(win: Window = window): boolean {
  const platform = (win as { bosonPlatform?: string }).bosonPlatform;
  if (platform === 'ios' || platform === 'android') return true;
  return typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches;
}

/**
 * Tracks the visual viewport on touch screens (see above). Returns a stop
 * function; a no-op where there's no visualViewport or no touch screen.
 */
export function trackVisualViewport(win: Window = window): () => void {
  const vv = win.visualViewport as VV | null | undefined;
  if (!vv || !wantsViewportTracking(win)) return () => {};
  const root = win.document.documentElement;
  const env: ViewportEnv = {
    root,
    vv,
    layoutHeight: () => win.innerHeight,
    scrollY: () => win.scrollY,
    scrollTo: (y) => win.scrollTo(0, y),
  };
  // The keyboard-less height: the tallest the visual viewport has been at
  // this orientation (Android's resized webview shrinks innerHeight too).
  let baseline = Math.max(vv.height, env.layoutHeight());
  let rotated = false;
  let frame: number | null = null;
  const update = (): void => {
    frame = null;
    if (rotated) baseline = Math.max(vv.height, env.layoutHeight());
    rotated = false;
    baseline = Math.max(baseline, vv.height);
    applyViewport(env, baseline);
  };
  const schedule = (): void => {
    if (frame === null) frame = win.requestAnimationFrame(update);
  };
  const onOrientation = (): void => {
    rotated = true;
    schedule();
  };
  root.classList.add('vv-tracked');
  update();
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  // The window too: a resize the visual viewport doesn't report must not
  // leave a stale height behind.
  win.addEventListener('resize', schedule);
  win.addEventListener('orientationchange', onOrientation);
  // A rotation also changes the width; reset the baseline then.
  const mq = typeof win.matchMedia === 'function' ? win.matchMedia('(orientation: landscape)') : null;
  mq?.addEventListener?.('change', onOrientation);
  return () => {
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    win.removeEventListener('orientationchange', onOrientation);
    mq?.removeEventListener?.('change', onOrientation);
    if (frame !== null) win.cancelAnimationFrame(frame);
    root.classList.remove('vv-tracked', 'kb-open');
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--app-top');
  };
}
