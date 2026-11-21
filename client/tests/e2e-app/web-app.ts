// The web build (platform/web: the engine as WebAssembly, browser bridges)
// under the real-app e2e suite, with E2E_TARGET=web. The same specs as the
// desktop app (desktop-app.ts): `launchWebApp` returns the same handle.
//
// The page is served once per run on the stack's fixed web origin
// (web-server.ts); each test profile gets its own persistent browser
// context (its own storage), in the Playwright project's browser. What the
// desktop app takes from its environment for tests (BOSON_NETWORK_JSON, the
// API outage switch, …) reaches the page as window.bosonWebE2EEnv through
// an init script, read by platform/web.
import { chromium, firefox, webkit, type BrowserContext, type BrowserType, type Page } from '@playwright/test';
import { join } from 'node:path';
import type { Profile } from './fixtures';
import type { App, DesktopLaunch, DeviceOptions } from './desktop-app';
import { STACK } from './stack';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

const BROWSERS: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };

// The desktop app's test environment, for the page.
function pageEnv(env: Record<string, string>): Record<string, string> {
  const keep = ['BOSON_NETWORK_JSON', 'BOSON_E2E_API_DOWN', 'BOSON_E2E_HOST_MAP'];
  const out: Record<string, string> = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

export async function launchWebApp(
  p: Profile, env: Record<string, string>, args: string[] = [], device: DeviceOptions & { browserName?: BrowserName } = {},
): Promise<DesktopLaunch> {
  const logs: string[] = [];
  const dbg = (m: string): void => { if (process.env['E2E_WEB_DEBUG']) process.stdout.write(`[web-app] ${m}\n`); };
  dbg('launching');
  const browser = BROWSERS[device.browserName ?? 'chromium'];
  const { browserName: _b, ...dev } = device;
  // Firefox has no mobile emulation (viewport + touch still apply).
  if (device.browserName === 'firefox') delete dev.isMobile;
  const permissions = (device.browserName ?? 'chromium') === 'chromium' ? ['notifications', 'clipboard-read', 'clipboard-write'] : [];
  const context: BrowserContext = await browser.launchPersistentContext(join(p.userData, `web-${device.browserName ?? 'chromium'}`), {
    viewport: { width: 1280, height: 800 },
    ...dev,
    permissions,
  });
  dbg('launched');
  await context.addInitScript((e) => { (window as unknown as { bosonWebE2EEnv: unknown }).bosonWebE2EEnv = e; }, pageEnv(env));
  const page: Page = context.pages()[0] ?? (await context.newPage());
  const log = (line: string): void => {
    logs.push(line);
    if (process.env['E2E_WEB_DEBUG']) process.stdout.write(line);
  };
  page.on('console', (m) => log(`[renderer ${m.type()}] ${m.text()}\n`));
  page.on('pageerror', (e) => log(`[renderer pageerror] ${e.message}\n`));
  page.on('crash', () => log('[renderer] the page crashed\n'));
  // A cold start from a link (the desktop gets the boson:// URL as argv):
  // a link to the web app carrying it.
  const link = args.find((a) => a.startsWith('boson://'));
  const url = new URL(STACK.web.url);
  if (link) url.searchParams.set('join', link);
  // Not 'load': that also waits for the Google Fonts stylesheet.
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  dbg('loaded');
  await page.waitForFunction(() => 'bosonShellReady' in window, null, { timeout: 30_000 });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Let in-flight chat-history writes land (see desktop-app.ts).
    if (!page.isClosed()) {
      await page.evaluate(async () => {
        const dbs = await indexedDB.databases?.() ?? [];
        if (!dbs.some((d) => d.name === 'boson-chat-history')) return;
        await new Promise<void>((done) => {
          const req = indexedDB.open('boson-chat-history');
          req.onerror = () => done();
          req.onsuccess = () => {
            const db = req.result;
            const finish = (): void => { db.close(); done(); };
            if (db.objectStoreNames.length === 0) return finish();
            const tx = db.transaction(Array.from(db.objectStoreNames), 'readonly');
            tx.oncomplete = finish;
            tx.onerror = finish;
            tx.onabort = finish;
          };
        });
      }).catch(() => {});
    }
    await context.close().catch(() => {});
  };

  type E2E = { openedLinks: () => Promise<string[] | null>; secondInstance: (args: string[]) => Promise<void> };
  const openedExternally = (): Promise<string[]> =>
    page.evaluate(async () => (await (window as unknown as { bosonE2E: E2E }).bosonE2E.openedLinks()) ?? []);
  const app: App = {
    process: () => { throw new Error('the web build has no app process'); },
    secondInstance: async (a: string[]) => {
      await page.evaluate((x) => (window as unknown as { bosonE2E: E2E }).bosonE2E.secondInstance(x), a);
    },
    windows: () => context.pages(),
    context: () => context,
    close,
  };
  return { app, page, logs, close, openedExternally };
}
