// Shared fixtures for the real-app Electron e2e suite.
//
// Every test gets a throwaway profile directory holding:
//   home/      → $HOME          (engine discovery file fallback, dotfiles)
//   run/       → $XDG_RUNTIME_DIR (engine writes run/boson/engine.json here)
//   userData/  → --user-data-dir (Electron userData: localStorage, the
//                secure-store file, the persisted renderer port, …)
// so nothing touches the developer's ~/.boson, real app profile, or keychain
// (--use-mock-keychain on macOS; the basic password store on Linux).
//
// `launchApp()` can be called repeatedly with the same profile to test
// restore-on-relaunch. Apps are closed and the profile is deleted in
// teardown; on failure, main-process logs (incl. the engine sidecar's) and a
// trace + screenshot of the main window are attached to the report.
//
// With E2E_COVERAGE=1 every launch also collects code coverage for the
// renderer, main/preload and engine (see coverage/config.ts).
//
// With E2E_VIDEO=1 every window of every launch is recorded, passing or not,
// and the videos are attached to the report (`npx playwright show-report`).
//
// Account-mode fixtures (createAccount / account / backendApi / mailpit)
// need the full e2e stack (`make test-e2e-app-up`); zncUser leases one of
// the ZNC users so tests can run in parallel. See README.md next to this
// file for the whole fixture/helper API.
import { test as base, expect, _electron, type ElectronApplication, type Page, type Locator } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { COVERAGE, ELECTRON_HOOK, RAW, RENDERER_CHUNK_URL, isPreloadUrl } from './coverage/config';
import { APP_DIR, STACK } from './stack';
import { BackendApi, provisionIdentity, randomHandle } from './helpers/backend';
import { Mailpit } from './helpers/mailpit';
import { createConfirmedUser, deleteAuthUser, type AuthUser } from './helpers/supabase';
import { leaseZncUser, resetZncUser, type ZncUser } from './helpers/znc';

export { APP_DIR, STACK };

// Stubs the app's OS boson:// handler registration (see the file).
const SANDBOX_HOOK = join(dirname(fileURLToPath(import.meta.url)), 'electron-sandbox-hook.cjs');
// Record every window of every launch (see the header comment).
const VIDEO = process.env['E2E_VIDEO'] === '1';

// Window recording for E2E_VIDEO. Playwright's own recordVideo stops
// Electron's renderer from starting on macOS, so frames come from Chromium's
// screencast over CDP instead (sent only when the window changes), and ffmpeg
// stitches them into an MP4 with their real timing when the launch ends.
interface Recording { stop(): Promise<string | null> }

let warnedNoFfmpeg = false;

async function startRecording(page: Page, dir: string): Promise<Recording | null> {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    if (!warnedNoFfmpeg) console.warn('[e2e] E2E_VIDEO=1 needs ffmpeg on PATH; not recording');
    warnedNoFfmpeg = true;
    return null;
  }
  mkdirSync(dir, { recursive: true });
  const frames: Array<{ file: string; t: number }> = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    const file = join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800 });
  return {
    async stop() {
      // The window may already be gone (the test closed the app); the frames
      // received so far still make the video.
      await cdp.send('Page.stopScreencast').catch(() => {});
      if (frames.length === 0) return null;
      const list = frames.flatMap((f, i) => {
        const next = frames[i + 1]?.t ?? f.t + 1;
        return [`file '${f.file}'`, `duration ${Math.max(next - f.t, 0.01).toFixed(3)}`];
      });
      list.push(`file '${frames[frames.length - 1]!.file}'`);
      const listFile = join(dir, 'frames.txt');
      writeFileSync(listFile, list.join('\n'));
      const out = `${dir}.mp4`;
      const r = spawnSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p', '-r', '30', out,
      ]);
      rmSync(dir, { recursive: true, force: true });
      return r.status === 0 ? out : null;
    },
  };
}

// Test IRC infra (infra/e2e/docker-compose.yml). The app's engine and the
// peer bot both reach ergo on the host port; ZNC reaches it as `ergo` on the
// compose network.
export const IRC_HOST = process.env['E2E_IRC_HOST'] ?? STACK.irc.host;
export const IRC_PORT = Number(process.env['E2E_IRC_PORT'] ?? STACK.irc.port);
export const ZNC_HOST = process.env['E2E_ZNC_HOST'] ?? STACK.znc.host;
export const ZNC_PORT = Number(process.env['E2E_ZNC_PORT'] ?? STACK.znc.port);

export function uid(len = 6): string {
  return randomBytes(8).toString('hex').slice(0, len);
}

// Unique-per-call names, so tests never share IRC state (in parallel or
// across runs against a long-lived ergo).
export const randomChannel = (prefix = 'e2e'): string => `#${prefix}-${uid(8)}`;
export const randomNick = (prefix = 'n'): string => `${prefix}${uid(7)}`;

export interface Profile {
  root: string;
  home: string;
  runtime: string;
  userData: string;
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  // URLs the app tried to hand to the OS browser (shell.openExternal is
  // stubbed so a test never opens the developer's browser).
  openedExternally: () => Promise<string[]>;
}

function makeProfile(): Profile {
  // Short base path: Chromium puts a SingletonSocket under userData and unix
  // socket paths are capped at ~104 bytes on macOS.
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'boson-e2e-'));
  const p = { root, home: join(root, 'home'), runtime: join(root, 'run'), userData: join(root, 'userData') };
  for (const d of [p.home, p.runtime, p.userData]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return p;
}

// The main window loads the renderer from the loopback server
// (http://127.0.0.1:<port>/index.html). Other windows can exist briefly — the
// one-time storage-migration probe opens hidden file:// windows — so match on
// URL rather than taking firstWindow().
async function mainWindow(app: ElectronApplication, timeoutMs = 30_000): Promise<Page> {
  const isMain = (p: Page): boolean => /^http:\/\/127\.0\.0\.1:\d+\/index\.html/.test(p.url());
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find(isMain);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`main window never loaded; windows: ${app.windows().map((w) => w.url()).join(', ') || '(none)'}`);
}

// Coverage mode: take the renderer/preload V8 coverage that electron-hook.cjs
// has been recording, and keep only the app's own bundles (not Electron's
// internal sandbox bundle or anonymous eval'd snippets).
async function saveRendererCoverage(app: ElectronApplication): Promise<void> {
  const entries = await app
    .evaluate(() => (globalThis as unknown as { __bosonE2ETakeCoverage: () => Promise<Array<{ url: string }>> }).__bosonE2ETakeCoverage())
    .catch((err: unknown) => {
      console.warn(`[e2e-coverage] could not take renderer coverage: ${String(err)}`);
      return [];
    });
  const keep = entries.filter((e) => RENDERER_CHUNK_URL.test(e.url) || isPreloadUrl(e.url));
  if (keep.length > 0) writeFileSync(join(RAW.renderer, `${randomUUID()}.json`), JSON.stringify(keep));
}

export interface Account extends AuthUser {
  // Set when the account has its Boson identity (POST /me) — signing in
  // then lands in the directory instead of the handle setup.
  handle?: string;
  recoveryCode?: string;
}

export interface CreateAccountOptions {
  email?: string;
  password?: string;
  // true → random handle; a string → that handle; false (default for
  // createAccount) → no identity yet: the first sign-in shows the setup.
  handle?: boolean | string;
}

interface Fixtures {
  profile: Profile;
  // `args`: extra command-line arguments for this launch (e.g. a boson://
  // URL, as the OS passes one on a cold start from a link click). `env`:
  // extra environment for the app (e.g. BOSON_E2E_HOST_MAP, see
  // electron-sandbox-hook.cjs).
  launchApp: (opts?: { profile?: Profile; args?: string[]; env?: Record<string, string> }) => Promise<LaunchedApp>;
  // A ZNC user (tester1..8) leased for this test and reset to its initial
  // state: network `ergo` disconnected upstream, no channels.
  zncUser: ZncUser;
  // Confirmed Supabase users (admin API), deleted after the test.
  createAccount: (opts?: CreateAccountOptions) => Promise<Account>;
  // createAccount({ handle: true }): signs straight into the directory.
  account: Account;
  // API client for the e2e backend — anonymous, or authed as `user`.
  backendApi: (user?: Pick<AuthUser, 'email' | 'password'>) => Promise<BackendApi>;
  mailpit: { users: Mailpit; catchall: Mailpit };
}

// Account fixtures need the whole e2e stack; fail with instructions instead
// of a sign-in timeout when it isn't up.
let accountStackChecked: Promise<void> | null = null;
function requireAccountStack(): Promise<void> {
  accountStackChecked ??= (async () => {
    const problems: string[] = [];
    const ok = async (url: string): Promise<boolean> => {
      try { return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok; } catch { return false; }
    };
    if (!(await ok(`${STACK.backend.url}/health`))) problems.push(`backend not answering on ${STACK.backend.url}/health`);
    if (!(await ok(`${STACK.supabase.apiUrl}/auth/v1/health?apikey=${STACK.supabase.publishableKey}`))) {
      problems.push(`Supabase Auth not answering on ${STACK.supabase.apiUrl}`);
    }
    if (!(await ok(`${STACK.supabase.mailpitUrl}/api/v1/info`))) problems.push(`auth Mailpit not answering on ${STACK.supabase.mailpitUrl}`);
    if (problems.length > 0) {
      throw new Error(`account-mode e2e stack is not up:\n  - ${problems.join('\n  - ')}\nRun \`make test-e2e-app-up\` (repo root).`);
    }
  })();
  return accountStackChecked;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  zncUser: async ({}, use, testInfo) => {
    const lease = await leaseZncUser(testInfo.workerIndex);
    try {
      await resetZncUser(lease);
      await use(lease);
    } finally {
      lease.release();
    }
  },

  // eslint-disable-next-line no-empty-pattern
  createAccount: async ({}, use) => {
    await requireAccountStack();
    const created: Account[] = [];
    await use(async (opts = {}) => {
      const user = await createConfirmedUser({ email: opts.email, password: opts.password });
      const acct: Account = { ...user };
      created.push(acct);
      if (opts.handle) {
        const ident = await provisionIdentity(user, typeof opts.handle === 'string' ? opts.handle : randomHandle());
        Object.assign(acct, ident);
      }
      return acct;
    });
    for (const a of created) await deleteAuthUser(a.id).catch(() => {});
  },

  account: async ({ createAccount }, use) => {
    await use(await createAccount({ handle: true }));
  },

  // eslint-disable-next-line no-empty-pattern
  backendApi: async ({}, use) => {
    await requireAccountStack();
    await use((user) => (user ? BackendApi.as(user) : Promise.resolve(BackendApi.anonymous())));
  },

  // eslint-disable-next-line no-empty-pattern
  mailpit: async ({}, use) => {
    await use({ users: Mailpit.users(), catchall: Mailpit.catchall() });
  },

  // eslint-disable-next-line no-empty-pattern
  profile: async ({}, use) => {
    const p = makeProfile();
    await use(p);
    rmSync(p.root, { recursive: true, force: true });
  },

  launchApp: async ({ profile }, use, testInfo) => {
    if (!existsSync(join(APP_DIR, 'package.json'))) {
      throw new Error(`${APP_DIR} is missing — run \`npm run build:e2e-app\` (or \`make test-e2e-app\`) first.`);
    }
    const launched: Array<{ app: ElectronApplication; logs: string[]; n: number; recording: Recording | null }> = [];

    const launch = async (opts: { profile?: Profile; args?: string[]; env?: Record<string, string> } = {}): Promise<LaunchedApp> => {
      const p = opts.profile ?? profile;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      // Never let a dev-server URL leak in: the app must serve its own build.
      delete env['ELECTRON_RENDERER_URL'];
      delete env['ELECTRON_RUN_AS_NODE'];
      Object.assign(env, {
        HOME: p.home,
        XDG_RUNTIME_DIR: p.runtime,
        XDG_CONFIG_HOME: join(p.home, '.config'),
        // Make Electron print renderer console output to stdout so it lands
        // in the attached log.
        ELECTRON_ENABLE_LOGGING: '1',
      });
      if (opts.env) Object.assign(env, opts.env);
      if (COVERAGE) {
        // Main process: Node writes V8 coverage here on exit. Engine: the
        // main process passes its env through to the sidecar.
        env['NODE_V8_COVERAGE'] = RAW.main;
        env['GOCOVERDIR'] = RAW.engine;
        writeFileSync(join(RAW.launches, randomUUID()), '');
      }

      const args = ['-r', SANDBOX_HOOK, APP_DIR, `--user-data-dir=${p.userData}`];
      // Preloaded ahead of the app's main bundle so renderer coverage starts
      // before the first page script runs.
      if (COVERAGE) args.unshift('-r', ELECTRON_HOOK);
      if (process.platform === 'darwin') args.push('--use-mock-keychain');
      if (process.platform === 'linux') {
        // CI containers lack the setuid sandbox helper + a keyring daemon.
        args.push('--no-sandbox', '--password-store=basic', '--disable-gpu');
      }
      if (opts.args) args.push(...opts.args);

      const app = await _electron.launch({ args, env, timeout: 60_000 });
      if (COVERAGE) {
        // Collect before ANY close — the teardown below and specs that close
        // the app themselves (restore.spec relaunches). close() quits the app
        // gracefully, which lets the main process and engine flush theirs.
        const close = app.close.bind(app);
        let saved = false;
        app.close = async () => {
          if (!saved) {
            saved = true;
            await saveRendererCoverage(app);
          }
          await close();
        };
      }
      const logs: string[] = [];
      const n = launched.length + 1;
      const entry = { app, logs, n, recording: null as Recording | null };
      launched.push(entry);
      const proc = app.process();
      proc.stdout?.on('data', (b: Buffer) => logs.push(b.toString()));
      proc.stderr?.on('data', (b: Buffer) => logs.push(b.toString()));

      // Stub the OS-browser handoff before the renderer can trigger it.
      await app.evaluate(({ shell }) => {
        const g = globalThis as unknown as { __e2eOpened: string[] };
        g.__e2eOpened = [];
        shell.openExternal = async (url: string) => {
          g.__e2eOpened.push(url);
        };
      });

      const page = await mainWindow(app);
      await page.waitForLoadState('domcontentloaded');
      if (VIDEO) entry.recording = await startRecording(page, testInfo.outputPath(`video-launch-${n}`));
      await page.context().tracing.start({ screenshots: true, snapshots: true, title: `${testInfo.title} (launch ${n})` })
        .catch(() => { /* tracing already running for this context */ });

      return {
        app,
        page,
        openedExternally: () =>
          app.evaluate(() => (globalThis as unknown as { __e2eOpened: string[] }).__e2eOpened.slice()),
      };
    };

    await use(launch);

    const failed = testInfo.status !== testInfo.expectedStatus;
    for (const { app, logs, n, recording } of launched) {
      const page = app.windows().find((w) => /\/index\.html/.test(w.url()));
      if (failed && page && !page.isClosed()) {
        const shot = await page.screenshot().catch(() => null);
        if (shot) await testInfo.attach(`screenshot-launch-${n}`, { body: shot, contentType: 'image/png' });
        const tracePath = testInfo.outputPath(`trace-launch-${n}.zip`);
        await page.context().tracing.stop({ path: tracePath }).catch(() => {});
        if (existsSync(tracePath)) await testInfo.attach(`trace-launch-${n}`, { path: tracePath, contentType: 'application/zip' });
      }
      await app.close().catch(() => {});
      const video = await recording?.stop();
      if (video) await testInfo.attach(`video-launch-${n}`, { path: video, contentType: 'video/mp4' });
      if (failed) {
        const logPath = testInfo.outputPath(`main-process-launch-${n}.log`);
        writeFileSync(logPath, logs.join(''));
        await testInfo.attach(`main-process-log-launch-${n}`, { path: logPath, contentType: 'text/plain' });
      }
    }
  },
});

export { expect };

// ---- UI helpers ------------------------------------------------------------

// The design-system <Field> renders a <label> next to (not wrapping /
// for=) its input, so getByLabel can't see it. Locate the input through the
// field container whose label text is exactly `label`.
export function field(scope: Page | Locator, label: string): Locator {
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page);
  const labelRe = new RegExp(`^\\s*${escapeRe(label)}(\\s*\\(optional\\))?\\s*$`);
  return scope
    .locator('.bds-field')
    .filter({ has: page.locator('label.bds-field-label', { hasText: labelRe }) })
    .locator('input, textarea')
    .first();
}

// Login screen → "Continue without an account" → nick → directory.
export async function continueAsGuest(page: Page, nick: string): Promise<void> {
  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await page.getByPlaceholder('your-nick').fill(nick);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Server Directory' })).toBeVisible({ timeout: 20_000 });
}

// Directory → Advanced → "+ Add server manually" → fill → Add. Leaves the
// new card visible in the directory grid.
export async function addServerManually(
  page: Page,
  s: { hostname: string; port: number; name: string; tls?: boolean },
): Promise<void> {
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: '+ Add server manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a server manually' });
  await expect(dialog).toBeVisible();
  await field(dialog, 'Hostname').fill(s.hostname);
  await field(dialog, 'Port').fill(String(s.port));
  await field(dialog, 'Display name').fill(s.name);
  const tls = dialog.getByRole('checkbox', { name: 'Use TLS (recommended)' });
  // The checkbox itself is visually hidden behind the toggle track; click
  // the wrapping label like a user would.
  if ((await tls.isChecked()) !== (s.tls ?? false)) await dialog.getByText('Use TLS (recommended)').click();
  await expect(tls).toBeChecked({ checked: s.tls ?? false });
  await dialog.getByRole('button', { name: /^Add/ }).click();
  await expect(dialog).toBeHidden();
}

export function serverCard(page: Page, name: string): Locator {
  return page.locator('article.directory-card').filter({ hasText: name });
}

// Channel sidebar "+" → type the channel → Enter. Resolves once the channel
// is the active conversation (composer placeholder names it).
export async function joinChannel(page: Page, channel: string): Promise<void> {
  await page.getByRole('button', { name: 'Add channel' }).click();
  const input = page.getByPlaceholder('Search channels by name or topic — or type #channel to join directly');
  await input.fill(channel);
  await input.press('Enter');
  await expect(composer(page, channel)).toBeVisible({ timeout: 20_000 });
}

export function composer(page: Page, channel?: string): Locator {
  if (channel) {
    const bare = channel.replace(/^#/, '');
    return page.getByPlaceholder(new RegExp(`^Message #?${escapeRe(bare)}$`));
  }
  return page.getByPlaceholder(/^Message /);
}

export function memberList(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Members' });
}

export function messageList(page: Page): Locator {
  return page.locator('main');
}

export async function sendMessage(page: Page, channel: string, text: string): Promise<void> {
  const box = composer(page, channel);
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Bouncer UI ------------------------------------------------------------

// User Settings → Bouncer: enable + save the global bouncer profile.
export async function configureBouncerProfile(
  page: Page,
  p: { host: string; port: number; username: string; password: string; tls?: boolean },
): Promise<void> {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: /^Bouncer/ }).click();

  const toggle = async (label: string, want: boolean): Promise<void> => {
    const box = dialog.getByRole('checkbox', { name: label, exact: true });
    if ((await box.isChecked()) !== want) await dialog.getByText(label, { exact: true }).click();
    await expect(box).toBeChecked({ checked: want });
  };
  await toggle('Use a bouncer', true);
  await field(dialog, 'Host').fill(p.host);
  await field(dialog, 'Port').fill(String(p.port));
  await toggle('Use TLS', p.tls ?? false);
  await field(dialog, 'Username').fill(p.username);
  await field(dialog, 'Password').fill(p.password);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
}

// ---- Helpers, re-exported so specs import everything from './fixtures' -----

export * from './helpers/account';
export { BackendApi, backendSql, provisionIdentity, randomHandle, seedServer } from './helpers/backend';
export type { DirectoryServer, SeedServerInput } from './helpers/backend';
export { Mailpit, extractCode, extractLinks } from './helpers/mailpit';
export type { MailMessage, MailSummary } from './helpers/mailpit';
export {
  createConfirmedUser, deleteAuthUser, findAuthUserByEmail, randomEmail, randomPassword, setAuthPassword, signInWithPassword,
} from './helpers/supabase';
export type { AuthUser, AuthSession } from './helpers/supabase';
export { leaseZncUser, resetZncUser } from './helpers/znc';
export type { ZncLease, ZncUser } from './helpers/znc';
