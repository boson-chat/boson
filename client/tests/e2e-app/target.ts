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
  let inTest = true;
  try { test.info(); } catch { inTest = false; }
  if (inTest) test.skip(IS_WEB && test.info().project.use.browserName === browser, `web ${browser}: ${reason}`);
  else test.skip(({ browserName }) => IS_WEB && browserName === browser, `web ${browser}: ${reason}`);
}

// What the secure store keeps on disk, key → stored value: the desktop's
// identity-store.json, or the web build's IndexedDB (platform/web/
// secure-store.ts). Values are ciphertext tagged SECURE_STORE_TAG.
export const SECURE_STORE_TAG = IS_WEB ? /^wb1:/ : /^fb1:/;

export async function secureStoreOnDisk(page: import('@playwright/test').Page, userData: string): Promise<Record<string, string>> {
  if (!IS_WEB) {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    try { return JSON.parse(readFileSync(join(userData, 'identity-store.json'), 'utf8')) as Record<string, string>; } catch { return {}; }
  }
  return page.evaluate(() => new Promise<Record<string, string>>((resolve) => {
    const r = indexedDB.open('boson-secure');
    r.onerror = () => resolve({});
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) { db.close(); resolve({}); return; }
      const out: Record<string, string> = {};
      const c = db.transaction('kv').objectStore('kv').openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) { db.close(); resolve(out); return; }
        const k = String(cur.key);
        if (k.startsWith('v:') && typeof cur.value === 'string') out[k.slice(2)] = cur.value;
        cur.continue();
      };
      c.onerror = () => { db.close(); resolve(out); };
    };
  }));
}

// Where images show from: the desktop's image cache route on the app's
// own origin, or on the web the image itself (a files host URL) or a blob:
// (theme images, fetched by the branding bridge).
export const IMG = {
  theme: IS_WEB ? /^blob:/ : /^\/_boson\/img\?k=theme&/,
  themeCss: IS_WEB ? 'url("blob:' : '/_boson/img?k=theme',
  themeVar: IS_WEB ? /^url\("blob:/ : /^url\("\/_boson\/img\?k=theme&/,
  file: IS_WEB ? /^(blob:|https?:\/\/[^/]+\/f\/)/ : /^\/_boson\/img\?k=file&/,
};

/**
 * Marks a test as a known failure in one web browser (test.fixme: not run,
 * reported as such): a gap in the web build there that's still to fix, not
 * something that can't apply. README.md, "Web target", lists them.
 */
export function webBrowserFixme(browser: 'chromium' | 'firefox' | 'webkit', reason: string): void {
  test.fixme(IS_WEB && test.info().project.use.browserName === browser, `web ${browser}: ${reason}`);
}
