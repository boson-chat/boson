// Directory / multi-server helpers for the directory-area specs.
import { deflateSync, crc32 } from 'node:zlib';
import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { backendSql } from './backend';
import { WAILS_SHELL } from '../wails-shell';

// Takes over the main process's `api:fetch` IPC handler (the renderer's only
// route to the backend — see src/main/api-proxy.ts) so a test can make the
// backend look down, or slow, for THIS app only, without touching the shared
// backend. "Down" sends each request to a closed loopback port, so the app
// sees a real connection-refused failure; "up" performs the request for real.
// Call before the renderer's first API request you want to affect.
export interface ApiControl {
  setDown(down: boolean): Promise<void>;
  setDelay(ms: number): Promise<void>;
  // Requests the renderer made through the proxy since install (method + path).
  requests(): Promise<string[]>;
}

export async function controlApi(app: ElectronApplication): Promise<ApiControl> {
  if (WAILS_SHELL) return wailsApiControl(app);
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __e2eApi?: { down: boolean; delayMs: number; log: string[] } };
    if (g.__e2eApi) return;
    const st = { down: false, delayMs: 0, log: [] as string[] };
    g.__e2eApi = st;
    ipcMain.removeHandler('api:fetch');
    ipcMain.handle('api:fetch', async (_evt, raw: unknown) => {
      const req = raw as { method: string; url: string; headers?: Record<string, string>; body?: string | ArrayBuffer | null };
      const u = new URL(req.url);
      st.log.push(`${req.method} ${u.pathname}${u.search}`);
      if (st.delayMs > 0) await new Promise((r) => setTimeout(r, st.delayMs));
      // Port 9 (discard) is closed on a dev machine / CI runner: the
      // connection is refused like a backend that's down.
      const target = st.down ? `http://127.0.0.1:9${u.pathname}${u.search}` : req.url;
      try {
        const body = req.body == null ? undefined : (typeof req.body === 'string' ? req.body : Buffer.from(req.body));
        const res = await fetch(target, { method: req.method, headers: req.headers, body, redirect: 'manual' });
        return { status: res.status, ok: res.ok, statusText: res.statusText, text: await res.text() };
      } catch (e) {
        const cause = (e as { cause?: { message?: string } }).cause?.message;
        return { status: 0, ok: false, statusText: cause ?? (e instanceof Error ? e.message : 'fetch failed'), text: '' };
      }
    });
  });
  const set = (patch: Record<string, unknown>): Promise<void> =>
    app.evaluate((_e, p) => {
      Object.assign((globalThis as unknown as { __e2eApi: object }).__e2eApi, p);
    }, patch);
  return {
    setDown: (down) => set({ down }),
    setDelay: (delayMs) => set({ delayMs }),
    requests: () => app.evaluate(() => (globalThis as unknown as { __e2eApi: { log: string[] } }).__e2eApi.log.slice()),
  };
}

// Directory search box → the server-side `q` (debounced in the bloc).
export async function searchDirectory(scope: Page | Locator, q: string): Promise<void> {
  const box = scope.getByRole('textbox', { name: 'Search servers' });
  await box.fill(q);
}

export function directoryCards(scope: Page | Locator): Locator {
  return scope.locator('article.directory-card');
}

// fixtures' serverCard(), for any scope (e.g. the server-browser modal).
export function cardIn(scope: Page | Locator, name: string): Locator {
  return directoryCards(scope).filter({ hasText: name });
}

// Server rail tile (aria-label is the name, plus " (connecting)" etc. while
// not connected).
export function railTile(page: Page, name: string): Locator {
  return page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: new RegExp(`^${escape(name)}`) });
}

export async function railContextMenu(page: Page, name: string): Promise<Locator> {
  await railTile(page, name).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

// Right-click a rail tile → "Server details" → the full-page settings.
export async function openServerSettings(page: Page, name: string): Promise<Locator> {
  const menu = await railContextMenu(page, name);
  await menu.getByRole('menuitem', { name: 'Server details' }).click();
  const settings = page.locator('main.server-settings');
  await expect(settings.locator('.server-settings-title')).toHaveText(name);
  return settings;
}

export function settingsTab(settings: Locator, label: string): Locator {
  return settings.getByRole('navigation', { name: 'Settings sections' })
    .getByRole('tab').filter({ has: settings.page().locator('.server-settings-menu-label', { hasText: new RegExp(`^${escape(label)}$`) }) });
}

// The chat view's sidebar header for the active server.
export function sidebarServerName(page: Page): Locator {
  return page.locator('.sidebar-server-name');
}

export async function expectConnected(page: Page, serverName: string): Promise<void> {
  await expect(sidebarServerName(page)).toHaveText(serverName, { timeout: 30_000 });
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
}

// Directory row fields only the backend's cron sets (user counts, health).
export function setServerStats(id: string, s: { userCount?: number | null; health?: 'up' | 'down' | 'unknown' }): void {
  const sets: string[] = [];
  if (s.userCount !== undefined) sets.push(`user_count = ${s.userCount === null ? 'NULL' : Number(s.userCount)}, user_count_updated_at = now()`);
  if (s.health) sets.push(`health_status = '${s.health}', health_last_checked_at = now()`);
  if (sets.length === 0) return;
  backendSql(`UPDATE servers SET ${sets.join(', ')} WHERE id = '${id}'`);
}

// A solid-color w×h RGB PNG, built by hand (no image deps in the test).
export function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The Wails shell's equivalent: the e2e build's API proxy hooks (desktop/e2e.go).
function wailsApiControl(app: ElectronApplication): ApiControl {
  type E2E = { setApi: (down: boolean, delayMs: number) => Promise<void>; apiRequests: () => Promise<string[]> };
  const page = app.windows()[0]!;
  const ready = page.waitForFunction(() => 'bosonE2E' in window);
  const state = { down: false, delayMs: 0 };
  const push = async (): Promise<void> => {
    await ready;
    await page.evaluate((s) => (window as unknown as { bosonE2E: E2E }).bosonE2E.setApi(s.down, s.delayMs), state);
  };
  return {
    setDown: (down) => { state.down = down; return push(); },
    setDelay: (delayMs) => { state.delayMs = delayMs; return push(); },
    requests: async () => {
      await ready;
      return page.evaluate(() => (window as unknown as { bosonE2E: E2E }).bosonE2E.apiRequests());
    },
  };
}
