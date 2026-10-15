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
import { chromium, type BrowserContext, type ElectronApplication, type Page } from '@playwright/test';
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

export async function launchWails(p: Profile, env: Record<string, string>): Promise<WailsLaunch> {
  if (!existsSync(WAILS_BIN)) {
    throw new Error(`${WAILS_BIN} is missing — run \`npm run build:e2e-wails\` first.`);
  }
  const port = await profilePort(p);
  const url = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn(WAILS_BIN, [], { env: { ...env, BOSON_SERVER_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (b: Buffer) => logs.push(b.toString()));
  child.stderr?.on('data', (b: Buffer) => logs.push(b.toString()));
  await waitHealthy(url, child, logs);

  const context: BrowserContext = await chromium.launchPersistentContext(join(p.userData, 'wails-browser'), {
    viewport: { width: 1280, height: 800 },
  });
  const page: Page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => logs.push(`[renderer ${m.type()}] ${m.text()}\n`));
  await page.goto(`${url}/`);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
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
    windows: () => context.pages(),
    close,
  } as unknown as ElectronApplication;

  return { app, page, logs, close, openedExternally: async () => [] };
}
