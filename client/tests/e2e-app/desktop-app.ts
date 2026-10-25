// The desktop app (desktop/) under the real-app e2e suite.
//
// It's built in server mode (scripts/build-e2e.mjs): the same Go services,
// in-process engine and renderer, served over HTTP instead of in a native
// webview, so Playwright can drive it in Chromium (it can't drive WKWebView
// or WebKitGTK). `launchDesktopApp` starts the server binary for a profile
// and opens the app in a persistent Chromium context kept under that
// profile, so a relaunch with the same profile finds its storage again. The
// port is fixed per profile for the same reason: web storage is keyed by
// origin. What a native window does (window controls, permissions,
// notifications) is checked by hand on the native build.
//
// With E2E_COVERAGE=1 (a coverage build, see build-e2e.mjs) each launch
// records the renderer's JS coverage from the first script on, and the Go
// binary (shell + engine) writes its counters to the engine raw dir when it
// exits on SIGTERM.
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchedApp, Profile } from './fixtures';
import { COVERAGE, RAW, RENDERER_CHUNK_URL } from './coverage/config';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const APP_BIN = join(repoRoot, 'desktop', 'bin', `boson-e2e-server${process.platform === 'win32' ? '.exe' : ''}`);

// The launched app's handle: the server process, its browser context and
// the second-launch stand-in.
export interface App {
  process(): ChildProcess;
  windows(): Page[];
  context(): BrowserContext;
  secondInstance(args: string[]): Promise<void>;
  close(): Promise<void>;
}

export interface DesktopLaunch extends LaunchedApp {
  logs: string[];
  close: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function profilePort(p: Profile): Promise<number> {
  const file = join(p.userData, 'app-port');
  if (existsSync(file)) return Number(readFileSync(file, 'utf8'));
  const port = await freePort();
  writeFileSync(file, String(port));
  return port;
}

async function waitHealthy(url: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited (${child.exitCode}):\n${logs.join('')}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`app not healthy at ${url} after 30s:\n${logs.join('')}`);
}

// The page's device: a desktop window by default; the mobile project
// (playwright.app.config.ts) passes a phone's viewport, touch and scale.
export interface DeviceOptions {
  viewport?: { width: number; height: number } | null;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

export async function launchDesktopApp(
  p: Profile, env: Record<string, string>, args: string[] = [], device: DeviceOptions = {},
): Promise<DesktopLaunch> {
  if (!existsSync(APP_BIN)) {
    throw new Error(`${APP_BIN} is missing — run \`npm run build:e2e-app\` first.`);
  }
  const port = await profilePort(p);
  const url = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const childEnv: Record<string, string> = { ...env, BOSON_SERVER_PORT: String(port) };
  if (COVERAGE) {
    childEnv['GOCOVERDIR'] = RAW.engine;
    writeFileSync(join(RAW.launches, randomUUID()), '');
  }
  const child = spawn(APP_BIN, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (b: Buffer) => logs.push(b.toString()));
  child.stderr?.on('data', (b: Buffer) => logs.push(b.toString()));
  await waitHealthy(url, child, logs);

  const context: BrowserContext = await chromium.launchPersistentContext(join(p.userData, 'browser'), {
    viewport: { width: 1280, height: 800 },
    ...device,
  });
  const page: Page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => logs.push(`[renderer ${m.type()}] ${m.text()}\n`));
  if (COVERAGE) await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.goto(`${url}/`);
  // The shell's bridges are installed asynchronously (platform/wails.ts).
  // Wait, so a spec can use them straight away.
  await page.waitForFunction(() => 'bosonShellReady' in window, null, { timeout: 30_000 });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (COVERAGE && !page.isClosed()) {
      const entries = await page.coverage.stopJSCoverage().catch((err: unknown) => {
        console.warn(`[e2e-coverage] could not take renderer coverage: ${String(err)}`);
        return [];
      });
      const keep = entries.filter((e) => RENDERER_CHUNK_URL.test(e.url));
      if (keep.length > 0) writeFileSync(join(RAW.renderer, `${randomUUID()}.json`), JSON.stringify(keep));
    }
    // Let in-flight chat-history writes land first (closing the browser aborts
    // them; quitting the native app lets them finish). A read-only
    // transaction over the stores is queued behind any pending write. Only
    // when the database exists: opening a missing one would create it empty.
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
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  };

  const app: App = {
    process: () => child,
    secondInstance: (a: string[]) => launchAgain(a),
    windows: () => context.pages(),
    context: () => context,
    close,
  };

  // The e2e build's stand-ins for the OS (desktop/e2e.go): links handed to
  // the browser are recorded, and a second launch can be simulated.
  type E2E = { openedLinks: () => Promise<string[] | null>; secondInstance: (args: string[]) => Promise<void> };
  const openedExternally = (): Promise<string[]> =>
    page.evaluate(async () => (await (window as unknown as { bosonE2E: E2E }).bosonE2E.openedLinks()) ?? []);
  const launchAgain = async (args: string[]): Promise<void> => {
    await page.evaluate((a) => (window as unknown as { bosonE2E: E2E }).bosonE2E.secondInstance(a), args);
  };

  return { app, page, logs, close, openedExternally };
}

// A second launch of the app with args: how the OS hands a boson:// link to
// a running app on Windows/Linux.
export function secondInstance(app: App, args: string[]): Promise<void> {
  return app.secondInstance(args);
}

// Calls one of the e2e build's hooks (window.bosonE2E, desktop/e2e.go) in the
// app's page.
export async function e2eHook<T = unknown>(app: App, method: string, ...args: unknown[]): Promise<T> {
  const page = app.windows()[0]!;
  return page.evaluate(
    ({ m, a }) => (window as unknown as { bosonE2E: Record<string, (...x: unknown[]) => Promise<unknown>> }).bosonE2E[m]!(...a),
    { m: method, a: args },
  ) as Promise<T>;
}
