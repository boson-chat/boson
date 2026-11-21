// What the real-app suite drives: the desktop app (default; desktop-app.ts)
// or the web build (E2E_TARGET=web; web-app.ts) in Chromium, Firefox or
// WebKit (the Playwright project's browserName). The specs are the same;
// the few that can only apply to the native app skip on the web through
// `webSkip()` (README.md lists them and why).
import { test } from '@playwright/test';

export type Target = 'desktop' | 'web';
export const TARGET: Target = process.env['E2E_TARGET'] === 'web' ? 'web' : 'desktop';
export const IS_WEB = TARGET === 'web';

/**
 * Skips the current test (or, at the top of a describe/file, all of them) on
 * the web build, with the reason. Only for what the web truly can't do —
 * a native window, the OS, the desktop's own fetchers or disk caches.
 */
export function webSkip(reason: string): void {
  test.skip(IS_WEB, `web: ${reason}`);
}

/** Skips in one web browser only (e.g. a WebKit gap). */
export function webBrowserSkip(browser: 'chromium' | 'firefox' | 'webkit', reason: string): void {
  test.skip(({ browserName }) => IS_WEB && browserName === browser, `web ${browser}: ${reason}`);
}
