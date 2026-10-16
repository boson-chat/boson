// The Wails shell under the real-app e2e suite (E2E_SHELL=wails).
//
// The shell is built in server mode (scripts/build-e2e-wails.mjs): the same
// Go services and renderer, served over HTTP instead of in a native webview,
// so Playwright can drive it in Chromium. `launchWails` stands in for
// `_electron.launch`: it starts the server binary for a profile and opens the
// app in a persistent Chromium context kept under that profile, so a
// relaunch with the same profile finds its storage again (as Electron's
// --user-data-dir does). The port is fixed per profile for the same reason:
// web storage is keyed by origin.
//
// Specs that reach into the Electron main process (`app.evaluate`) can't run
// here; `app.evaluate` throws, naming the spec's dependency.
import { chromium, test, type BrowserContext, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LaunchedApp, Profile } from './fixtures';

export const WAILS_SHELL = process.env['E2E_SHELL'] === 'wails';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const WAILS_BIN = join(repoRoot, 'desktop', 'bin', `boson-e2e-server${process.platform === 'win32' ? '.exe' : ''}`);

export interface WailsLaunch extends LaunchedApp {
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
  const file = join(p.userData, 'wails-port');
  if (existsSync(file)) return Number(readFileSync(file, 'utf8'));
  const port = await freePort();
  writeFileSync(file, String(port));
  return port;
}

async function waitHealthy(url: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wails shell exited (${child.exitCode}):\n${logs.join('')}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`wails shell not healthy at ${url} after 30s:\n${logs.join('')}`);
}

export async function launchWails(p: Profile, env: Record<string, string>, args: string[] = []): Promise<WailsLaunch> {
  if (!existsSync(WAILS_BIN)) {
    throw new Error(`${WAILS_BIN} is missing — run \`npm run build:e2e-wails\` first.`);
  }
  const port = await profilePort(p);
  const url = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn(WAILS_BIN, args, { env: { ...env, BOSON_SERVER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (b: Buffer) => logs.push(b.toString()));
  child.stderr?.on('data', (b: Buffer) => logs.push(b.toString()));
  await waitHealthy(url, child, logs);

  const context: BrowserContext = await chromium.launchPersistentContext(join(p.userData, 'wails-browser'), {
    viewport: { width: 1280, height: 800 },
  });
  const page: Page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => logs.push(`[renderer ${m.type()}] ${m.text()}\n`));
  await page.goto(`${url}/`);
  // The shell's bridges are installed asynchronously (platform/wails.ts);
  // Electron's preload has them in place before the page runs. Wait, so a
  // spec can use them straight away.
  await page.waitForFunction(() => 'bosonShellReady' in window, null, { timeout: 30_000 });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Let in-flight chat-history writes land first (closing the browser aborts
    // them; Electron's slower graceful quit hides this). A read-only
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

  const app = {
    evaluate: () => {
      throw new Error('app.evaluate reaches the Electron main process, which the Wails shell does not have');
    },
    process: () => child,
    secondInstance: (a: string[]) => launchAgain(a),
    windows: () => context.pages(),
    context: () => context,
    close,
  } as unknown as ElectronApplication;

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

// A second launch of the app with args — how the OS hands a boson:// link to a
// running app on Windows/Linux — in either shell.
export async function secondInstance(app: ElectronApplication, args: string[]): Promise<void> {
  const wails = (app as unknown as { secondInstance?: (a: string[]) => Promise<void> }).secondInstance;
  if (wails) return wails(args);
  await app.evaluate(({ app: electronApp }, a) => {
    electronApp.emit('second-instance', { preventDefault: () => {} }, [process.execPath, ...a], process.cwd(), {});
  }, args);
}

// Skips the calling test under the Wails shell: it exercises something only
// the Electron build has (its main process, the engine sidecar, the loopback
// renderer server). Covered for Wails by the native smoke tests instead.
export function electronOnly(reason: string): void {
  test.skip(WAILS_SHELL, `Electron only: ${reason}`);
}

// Calls one of the e2e build's hooks (window.bosonE2E, desktop/e2e.go) in the
// Wails app's page.
export async function wailsE2E<T = unknown>(app: ElectronApplication, method: string, ...args: unknown[]): Promise<T> {
  const page = app.windows()[0]!;
  return page.evaluate(
    ({ m, a }) => (window as unknown as { bosonE2E: Record<string, (...x: unknown[]) => Promise<unknown>> }).bosonE2E[m]!(...a),
    { m: method, a: args },
  ) as Promise<T>;
}
