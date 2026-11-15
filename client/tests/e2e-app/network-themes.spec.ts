// Network themes: a network's own colours, pane backgrounds, logo and
// sign-in background, over the user's theme while that network is the
// active server.
//
// The e2e stack's self-hosted network (auth2 + ergo2, see
// network-signin.spec.ts) gets branding the way a real one does: its
// boson.json (handed over with BOSON_NETWORK_JSON for `localhost`) names a
// boson-theme/1 document, here served by a local server this spec starts
// (with an ETag, like auth's /v1/branding). The same server is also a
// small network directory whose one listing carries a `theme`: the source
// for networks that don't serve their own. Image URLs are http on loopback,
// which only dev / e2e builds allow.
//
// Proves: the sign-in dialog and the login screen's "Use another server"
// show the network's logo and background; connecting applies its colours
// and pane image (CSS variables, the pane layer) and puts its logo on the
// rail tile and sidebar header; switching servers swaps the theme; the
// per-network toggle (rail menu) and the global switch (Appearance) turn it
// off; the theme is revalidated with its ETag on connect; a directory
// listing's theme applies, in its light variant for a user on a light theme
// and its primary (dark) once they switch to a dark one.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  test, expect, STACK, IRC_HOST, IRC_PORT, addServerManually, continueAsGuest, randomEmail, randomPassword,
  randomChannel, randomUsername, sendMessage, joinChannel, serverCard, uid,
} from './fixtures';
import {
  cardIn, expectConnected, openServerSettings, railContextMenu, railTile, searchDirectory, settingsTab,
} from './helpers/directory';

const NET = STACK.selfhost;
const SHOTS = process.env['NETTHEME_SHOTS_DIR'] ?? '';
// Boson's own Terminal accent (the user's theme here).
const DEFAULT_ACCENT = '#D97706';
const NET_ACCENT = '#7c3aed';
const DIR_ACCENT = '#0ea5e9';
// The listing theme's light variant (for users on a light theme).
const DIR_LIGHT_ACCENT = '#0369a1';
const DIR_LIGHT_BG = '#f4faff';
const DIR_LIGHT_SERVERS_BG = '#e0f2fe';

const LOGO_SVG = (fill: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${fill}"/>` +
  '<circle cx="32" cy="32" r="14" fill="none" stroke="#fff" stroke-width="6"/></svg>';

// A diagonal two-colour gradient PNG with soft rings, so a background is
// visibly a picture (built by hand: no image deps in the test).
function gradientPng(w: number, h: number, a: [number, number, number], b: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const ring = 0.85 + 0.15 * Math.sin(Math.hypot(x - w * 0.7, y - h * 0.3) / 9);
      for (let c = 0; c < 3; c++) raw[o + 1 + x * 3 + c] = Math.round((a[c]! * (1 - t) + b[c]! * t) * ring);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Hit { path: string; ifNoneMatch?: string }

interface BrandingServer {
  url: string;
  hits: Hit[];
  listing: { id: string; name: string; hostname: string };
  close(): Promise<void>;
}

// Serves the self-hosted network's theme document and images, and a
// one-listing network directory whose listing has a theme.
async function startBrandingServer(): Promise<BrandingServer> {
  const hits: Hit[] = [];
  const id = uid(8);
  const listing = { id: `net_theme_${id}`, name: `Themed ${id}`, hostname: `themed-${id}.localhost` };
  let base = '';
  const theme = () => ({
    version: 1,
    base: 'dark',
    colors: { accent: NET_ACCENT, bg: '#0b0b14', surface: '#11111c', 'surface-raised': '#181826' },
    radius: 4,
    panes: {
      servers: { bg: '#160f2a' },
      channels: { bg: '#11111c' },
      messages: { image: `${base}/img/messages.png`, dim: 0.55, blur: 6, position: 'center' },
    },
    logo: `${base}/img/logo.svg`,
    login_background: `${base}/img/login.png`,
  });
  const listingTheme = () => ({
    version: 1,
    base: 'dark',
    colors: { accent: DIR_ACCENT },
    logo: `${base}/img/dirlogo.svg`,
    variants: {
      light: {
        colors: { accent: DIR_LIGHT_ACCENT, bg: DIR_LIGHT_BG },
        panes: { servers: { bg: DIR_LIGHT_SERVERS_BG } },
      },
    },
  });
  const etag = '"theme-1"';
  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', ...headers });
    res.end(body);
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const inm = req.headers['if-none-match'];
    hits.push({ path, ...(typeof inm === 'string' ? { ifNoneMatch: inm } : {}) });
    switch (path) {
      case '/branding.json':
        if (inm === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
        send(res, 200, 'application/json', JSON.stringify(theme()), { ETag: etag });
        return;
      case '/img/logo.svg':
        send(res, 200, 'image/svg+xml', LOGO_SVG(NET_ACCENT));
        return;
      case '/img/dirlogo.svg':
        send(res, 200, 'image/svg+xml', LOGO_SVG(DIR_ACCENT));
        return;
      case '/img/login.png':
        send(res, 200, 'image/png', gradientPng(320, 200, [124, 58, 237], [14, 165, 233]));
        return;
      case '/img/messages.png':
        send(res, 200, 'image/png', gradientPng(320, 200, [70, 30, 140], [20, 20, 40]));
        return;
      case '/.well-known/boson-directory.json':
        send(res, 200, 'application/json', JSON.stringify({ name: 'Themed e2e directory', version: 1 }));
        return;
      default:
        if (path === '/v1/networks' || path === '/v1/networks/') {
          send(res, 200, 'application/json', JSON.stringify({
            networks: [{
              id: listing.id,
              hostname: listing.hostname,
              port: IRC_PORT,
              tls: false,
              name: listing.name,
              description: 'A listing with a theme',
              tags: [],
              languages: ['en'],
              status: 'verified',
              health_status: 'up',
              theme: listingTheme(),
            }],
          }));
          return;
        }
        send(res, 404, 'application/json', '{"error":"not found"}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: base, hits, listing, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function networkJson(brandingUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'boson-net-'));
  const file = join(dir, 'boson.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    irc: { host: NET.irc.host, port: NET.irc.port, tls: false },
    auth: { url: NET.auth.url },
    branding: brandingUrl,
  }));
  return file;
}

async function registerOnNetwork(): Promise<{ username: string; password: string }> {
  const username = randomUsername('nth');
  const password = randomPassword();
  const res = await fetch(`${NET.auth.url}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: randomEmail('nth'), password }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return { username, password };
}

const cssVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const accent = (page: Page): Promise<string> => cssVar(page, '--accent');

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// Adds the spec's directory (Settings → Directories) and connects to its
// one listing as a guest.
async function connectToListing(page: Page, brand: BrandingServer): Promise<void> {
  await continueAsGuest(page, `g${uid()}`);
  await page.getByRole('button', { name: 'User settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User settings' });
  await settings.getByRole('tab', { name: /Directories/ }).click();
  await settings.getByPlaceholder('directory.example.org').fill(brand.url);
  await settings.getByRole('button', { name: 'Add directory' }).click();
  await expect(settings.getByText('Themed e2e directory', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await settings.getByRole('button', { name: 'Close' }).click();

  await searchDirectory(page, brand.listing.name);
  const card = serverCard(page, brand.listing.name);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page, brand.listing.name);
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await dialog.getByRole('tab', { name: /Appearance/ }).click();
  return dialog;
}

test.describe('network themes', () => {
  let brand: BrandingServer;
  test.beforeEach(async () => { brand = await startBrandingServer(); });
  test.afterEach(async () => { await brand.close(); });

  test("a self-hosted network's theme: sign-in, connect, switch servers, turn it off", async ({ launchApp }) => {
    test.setTimeout(180_000);
    const user = await registerOnNetwork();
    const name = `Branded ${uid()}`;
    const plain = `Plain ${uid()}`;
    const { page } = await launchApp({ env: { BOSON_NETWORK_JSON: networkJson(`${brand.url}/branding.json`) } });
    await continueAsGuest(page, `g${uid()}`);
    expect(await accent(page)).toBe(DEFAULT_ACCENT);

    // "Sign in to <network>": its logo over its login background.
    await addServerManually(page, { hostname: NET.irc.host, port: NET.irc.port, name, tls: false });
    await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: `Sign in to ${name}` });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    const hero = dialog.getByTestId('network-brand-hero');
    await expect(hero).toBeVisible({ timeout: 15_000 });
    await expect(hero.getByRole('img', { name: `${name} logo` })).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => hero.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('blob:');
    await shot(page, '01-sign-in-dialog');

    await dialog.getByPlaceholder('username or email', { exact: true }).fill(user.username);
    await dialog.getByPlaceholder('password', { exact: true }).fill(user.password);
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expectConnected(page, name);

    // Connected: its colours, its pane picture, its logo.
    await expect.poll(() => accent(page)).toBe(NET_ACCENT);
    expect(await cssVar(page, '--bg')).toBe('#0b0b14');
    expect(await cssVar(page, '--radius-sm')).toBe('4px');
    expect(await cssVar(page, '--pane-servers-bg')).toBe('#160f2a');
    await expect.poll(() => cssVar(page, '--pane-messages-image')).toMatch(/^url\("blob:/);
    expect(await cssVar(page, '--pane-messages-blur')).toBe('6px');
    expect(await cssVar(page, '--pane-messages-dim')).toBe('0.55');
    expect(await page.evaluate(() => document.documentElement.dataset['networkTheme'])).toBe('localhost');
    const layer = await page.locator('main.chat-area').evaluate((el) => {
      const before = getComputedStyle(el, '::before');
      const after = getComputedStyle(el, '::after');
      return { image: before.backgroundImage, filter: before.filter, dim: after.opacity };
    });
    expect(layer.image).toContain('blob:');
    expect(layer.filter).toBe('blur(6px)');
    expect(layer.dim).toBe('0.55');
    expect(await page.locator('.server-rail').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(22, 15, 42)');
    await expect(railTile(page, name).locator('img.server-item-icon')).toHaveAttribute('src', /^blob:/);
    await expect(page.locator('.channel-sidebar-logo')).toHaveAttribute('src', /^blob:/);
    // Messages read over the picture.
    const channel = randomChannel('nth');
    await joinChannel(page, channel);
    await sendMessage(page, channel, 'Hello from a themed network: the picture sits under a dim layer, so this stays readable.');
    await expect(page.locator('.chat-messages')).toContainText('Hello from a themed network');
    // Revalidated on connect with the ETag the first fetch got.
    expect(brand.hits.some((h) => h.path === '/branding.json' && h.ifNoneMatch === '"theme-1"')).toBe(true);
    await shot(page, '02-connected-themed');

    // A second server without a theme: back to the user's own.
    await page.getByRole('button', { name: 'Browse / switch servers' }).click();
    const modal = page.getByRole('dialog', { name: 'Connect to a server' });
    await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: plain, tls: false });
    await cardIn(modal, plain).getByRole('button', { name: 'Connect' }).click();
    await expect(modal).toBeHidden();
    await expectConnected(page, plain);
    await expect.poll(() => accent(page)).toBe(DEFAULT_ACCENT);
    expect(await cssVar(page, '--pane-messages-image')).toBe('');
    expect(await page.evaluate(() => document.documentElement.dataset['networkTheme'])).toBeUndefined();
    await expect(page.locator('.channel-sidebar-logo')).toHaveCount(0);
    // Its rail tile keeps the network's logo.
    await expect(railTile(page, name).locator('img.server-item-icon')).toHaveAttribute('src', /^blob:/);
    await shot(page, '03-other-server-own-theme');

    // Back: the network's theme again.
    await railTile(page, name).click();
    await expectConnected(page, name);
    await expect.poll(() => accent(page)).toBe(NET_ACCENT);

    // Per network: the rail menu's "Use this network's theme".
    let menu = await railContextMenu(page, name);
    const item = menu.getByRole('menuitemcheckbox', { name: "Use this network's theme" });
    await expect(item).toHaveAttribute('aria-checked', 'true');
    await shot(page, '04-rail-menu');
    await item.click();
    await expect.poll(() => accent(page)).toBe(DEFAULT_ACCENT);
    expect(await cssVar(page, '--pane-messages-image')).toBe('');
    await expect(railTile(page, name).locator('img.server-item-icon')).toHaveCount(0);
    await expect(page.locator('.channel-sidebar-logo')).toHaveCount(0);
    menu = await railContextMenu(page, name);
    await expect(menu.getByRole('menuitemcheckbox', { name: "Use this network's theme" })).toHaveAttribute('aria-checked', 'false');
    await menu.getByRole('menuitemcheckbox', { name: "Use this network's theme" }).click();
    await expect.poll(() => accent(page)).toBe(NET_ACCENT);

    // The same switch in Server settings → Appearance.
    const server = await openServerSettings(page, name);
    await settingsTab(server, 'Appearance').click();
    const own = server.getByRole('checkbox', { name: "Use this network's theme" });
    await expect(own).toBeChecked();
    await shot(page, '04b-server-settings-appearance');
    await server.getByText("Use this network's theme", { exact: true }).click();
    await expect(own).not.toBeChecked();
    await expect.poll(() => accent(page)).toBe(DEFAULT_ACCENT);
    await server.getByText("Use this network's theme", { exact: true }).click();
    await expect.poll(() => accent(page)).toBe(NET_ACCENT);
    await server.getByRole('button', { name: 'Close settings' }).click();

    // Everywhere: Appearance → "Use network themes".
    const settings = await openAppearance(page);
    const toggle = settings.getByRole('checkbox', { name: 'Use network themes' });
    await expect(toggle).toBeChecked();
    await settings.getByText('Use network themes', { exact: true }).click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => accent(page)).toBe(DEFAULT_ACCENT);
    await shot(page, '05-appearance-switch-off');
    await settings.getByText('Use network themes', { exact: true }).click();
    await expect.poll(() => accent(page)).toBe(NET_ACCENT);
    await settings.getByRole('button', { name: 'Close' }).click();
  });

  test("the login screen's \"Use another server\" shows the network's logo and background", async ({ launchApp }) => {
    const { page } = await launchApp({ env: { BOSON_NETWORK_JSON: networkJson(`${brand.url}/branding.json`) } });
    await expect(page.locator('.login-server-host')).toHaveText('boson.chat', { timeout: 20_000 });
    // boson.chat (the e2e auth) publishes no branding: Boson's own look.
    await expect(page.locator('.login-screen-branded')).toHaveCount(0);
    await page.getByRole('button', { name: 'Use another server' }).click();
    await page.getByLabel('Server address').fill(NET.irc.host);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('.otherserver-network')).toBeVisible({ timeout: 15_000 });
    const screen = page.locator('.login-screen-branded');
    await expect(screen).toBeVisible({ timeout: 15_000 });
    expect(await screen.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('blob:');
    await expect(page.locator('.login-network-logo img')).toHaveAttribute('src', /^blob:/);
    await shot(page, '06-login-other-server');

    // Back to boson.chat: its own look again.
    await page.getByRole('button', { name: 'Back to boson.chat' }).click();
    await expect(page.locator('.login-screen-branded')).toHaveCount(0);
  });

  test("a directory listing's theme applies to a network that has none of its own", async ({ launchApp }) => {
    test.setTimeout(120_000);
    const { page } = await launchApp();
    await connectToListing(page, brand);
    await expect.poll(() => accent(page)).toBe(DIR_ACCENT);
    await expect(railTile(page, brand.listing.name).locator('img.server-item-icon')).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
    await expect(page.locator('.channel-sidebar-logo')).toHaveAttribute('src', /^blob:/);
    await shot(page, '07-directory-listing-theme');
  });

  test("a network's light variant shows on a light theme, its primary on a dark one", async ({ launchApp }) => {
    test.setTimeout(120_000);
    const { page } = await launchApp();
    await connectToListing(page, brand);
    // The user is on Terminal (dark): the primary.
    await expect.poll(() => accent(page)).toBe(DIR_ACCENT);
    expect(await cssVar(page, '--pane-servers-bg')).toBe('');

    // Switch to Daylight (light): the light variant.
    const settings = await openAppearance(page);
    await settings.getByRole('radio', { name: /^Daylight/ }).click();
    await expect(settings.getByRole('radio', { name: /^Daylight/ })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => accent(page)).toBe(DIR_LIGHT_ACCENT);
    expect(await cssVar(page, '--bg')).toBe(DIR_LIGHT_BG);
    expect(await cssVar(page, '--pane-servers-bg')).toBe(DIR_LIGHT_SERVERS_BG);
    expect(await page.evaluate(() => document.documentElement.dataset['themeBase'])).toBe('light');
    await settings.getByRole('button', { name: 'Close' }).click();
    expect(await page.locator('.server-rail').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(224, 242, 254)');
    await shot(page, '08-light-variant');

    // Back to a dark theme: the primary again.
    const again = await openAppearance(page);
    await again.getByRole('radio', { name: /^Terminal/ }).click();
    await expect.poll(() => accent(page)).toBe(DIR_ACCENT);
    expect(await cssVar(page, '--pane-servers-bg')).toBe('');
    expect(await page.evaluate(() => document.documentElement.dataset['themeBase'])).toBe('dark');
    await again.getByRole('button', { name: 'Close' }).click();
  });
});
