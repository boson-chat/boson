// Network channels: the channels a network puts new people in (#lobby), and
// networks where only admins create channels.
//
// Client side, against the e2e stack:
//   - a directory listing with `autojoin_channels` says "Joins #…" on its
//     card, and connecting from the card joins them on the FIRST connect to
//     that network (a few seconds after registration), not on later ones;
//   - on a network whose auth /v1/config says `channel_creation: admins`
//     (ergo3: Ergo with channels.operator-only-creation; the network's
//     /v1/config is served here), a guest's Join dialog says only admins
//     create channels and offers the network's channels, an existing one
//     can be joined, and joining one that doesn't exist says so plainly
//     instead of Ergo's raw 403.
//
// Server side (RoleServ joins people to #lobby: boson-chat/stack's
// network channels), gated: these need a boson stack with network channels
// configured, which the e2e stack doesn't run — see the last describe.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  test, expect, STACK, IRC_PORT, addServerManually, continueAsGuest, randomChannel, randomEmail, randomPassword,
  randomUsername, serverCard, uid,
} from './fixtures';
import { cardIn, expectConnected, railContextMenu, railTile, searchDirectory } from './helpers/directory';
import { banner, command, conversation, sidebar } from './helpers/chat';
import { IrcPeer } from './irc-peer';

type Handler = (path: string, res: ServerResponse) => boolean;

const SHOTS = process.env['NETCHAN_SHOTS_DIR'] ?? '';
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

// A tiny loopback HTTP server (CORS-open, for the web build too).
async function serve(handler: Handler): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST' });
      res.end();
      return;
    }
    if (!handler(path, res)) json(res, 404, { error: 'not_found', message: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function bosonJson(irc: { host: string; port: number }, authUrl: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'boson-netchan-')), 'boson.json');
  writeFileSync(file, JSON.stringify({ version: 1, irc: { host: irc.host, port: irc.port, tls: false }, auth: { url: authUrl } }));
  return file;
}

// Settings → Directories → add one.
async function addDirectory(page: Page, url: string, name: string): Promise<void> {
  await page.getByRole('button', { name: 'User settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User settings' });
  await settings.getByRole('tab', { name: /Directories/ }).click();
  await settings.getByPlaceholder('directory.example.org').fill(url);
  await settings.getByRole('button', { name: 'Add directory' }).click();
  await expect(settings.getByText(name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await settings.getByRole('button', { name: 'Close' }).click();
}

test.describe('network channels: a listing\'s default channels', () => {
  test('the card says what it joins; the first connect from it joins them, later ones do not', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const id = uid(8);
    const lobby = randomChannel('lobby');
    const listing = { id: `net_aj_${id}`, name: `Autojoin ${id}`, hostname: `aj-${id}.localhost` };
    const dirName = `Autojoin e2e directory ${id}`;
    const dir = await serve((path, res) => {
      if (path === '/.well-known/boson-directory.json') { json(res, 200, { name: dirName, version: 1 }); return true; }
      if (path === '/v1/networks' || path === '/v1/networks/') {
        json(res, 200, {
          networks: [{
            id: listing.id, hostname: listing.hostname, port: IRC_PORT, tls: false, name: listing.name,
            description: 'A listing with a default channel', tags: [], languages: ['en'],
            status: 'verified', health_status: 'up',
            channels: [lobby], autojoin_channels: [lobby],
          }],
        });
        return true;
      }
      return false;
    });
    try {
      const { page } = await launchApp();
      await continueAsGuest(page, `aj${uid()}`);
      await addDirectory(page, dir.url, dirName);
      await searchDirectory(page, listing.name);
      const card = serverCard(page, listing.name);
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.locator('.directory-card-joins')).toHaveText(`Joins ${lobby}`);
      await shot(page, '01-card-joins');

      await card.getByRole('button', { name: 'Connect' }).click();
      await expectConnected(page, listing.name);
      // The e2e ergo has no RoleServ: the client joins it (~3s after
      // registration), without asking.
      await expect(conversation(page, lobby)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByPlaceholder(new RegExp(`^Message #${lobby.slice(1)}$`, 'i'))).toBeVisible();

      // Leave it, leave the server, connect from the card again: it stays left.
      await command(page, '/part');
      await expect(conversation(page, lobby)).toHaveCount(0, { timeout: 15_000 });
      await (await railContextMenu(page, listing.name)).getByRole('menuitem', { name: 'Leave server' }).click();
      await expect(railTile(page, listing.name)).toHaveCount(0);

      await searchDirectory(page, listing.name);
      await cardIn(page, listing.name).getByRole('button', { name: 'Connect' }).click();
      await expectConnected(page, listing.name);
      // Well past the auto-join delay.
      await page.waitForTimeout(6_000);
      await expect(conversation(page, lobby)).toHaveCount(0);
      await expect(banner(page)).toHaveCount(0);
    } finally {
      await dir.close();
    }
  });
});

test.describe('network channels: only admins create channels', () => {
  const NET = STACK.adminsOnly;

  test('a guest is told up front, can join what exists, and gets a plain answer for what does not', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const name = `Admins only ${uid()}`;
    const existing = randomChannel('netchan');
    const missing = randomChannel('nochan');
    // An admin made `existing` (the network's RoleServ would): the peer
    // OPERs (chanreg) and joins it, so it exists for everyone.
    const admin = await IrcPeer.connect({ host: '127.0.0.1', port: NET.irc.port, nick: `adm${uid()}` });
    const auth = await serve((path, res) => {
      if (path !== '/v1/config') return false;
      json(res, 200, {
        registration: 'open', require_email_verification: false, sso_providers: [], guest_access: true,
        site_name: name, branding_url: null,
        channel_creation: 'admins',
        channels: [{ name: existing, topic: 'Made by an admin', autojoin: false }],
      });
      return true;
    });
    try {
      admin.send(`OPER ${NET.oper.name} ${NET.oper.password}`);
      await admin.waitFor((l) => l.command === '381', 15_000, 'RPL_YOUREOPER');
      await admin.join(existing);

      const { page } = await launchApp({ env: { BOSON_NETWORK_JSON: bosonJson(NET.irc, auth.url) } });
      await continueAsGuest(page, `ao${uid()}`);
      await addServerManually(page, { hostname: NET.irc.host, port: NET.irc.port, name, tls: false });
      await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
      const signIn = page.getByRole('dialog', { name: `Sign in to ${name}` });
      await expect(signIn).toBeVisible({ timeout: 20_000 });
      await signIn.getByRole('button', { name: 'Continue as guest' }).click();
      await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });

      // The Join dialog: who can create, and the network's channels.
      await expect(sidebar(page).getByRole('button', { name: 'Add channel' })).toHaveAttribute('title', 'Join a channel', { timeout: 15_000 });
      await sidebar(page).getByRole('button', { name: 'Add channel' }).click();
      const dialog = page.getByRole('dialog', { name: 'Join a channel' });
      await expect(dialog.getByTestId('channel-create-restricted')).toContainText('Only admins can create channels on this network.');
      await shot(page, '02-join-dialog-admins-only');
      await dialog.getByRole('group', { name: 'Network channels' }).getByRole('button', { name: existing }).click();
      await expect(page.getByPlaceholder(new RegExp(`^Message #${existing.slice(1)}$`, 'i'))).toBeVisible({ timeout: 20_000 });

      // A channel that doesn't exist: Ergo says "Only server operators can
      // create new channels" (403); the app says what that means here.
      await sidebar(page).getByRole('button', { name: 'Add channel' }).click();
      const box = dialog.getByPlaceholder('Search channels by name or topic — or type #channel to join directly');
      await box.fill(missing);
      await expect(dialog.getByText('Only admins can create new channels here.', { exact: false })).toBeVisible();
      await box.press('Enter');
      await expect(banner(page)).toContainText(`${missing} doesn't exist, and only admins can create channels on ${name}.`, { timeout: 20_000 });
      await expect(banner(page)).not.toContainText('server operators');
      await shot(page, '03-friendly-join-error');
      await expect(conversation(page, missing)).toHaveCount(0);
    } finally {
      await admin.quit().catch(() => {});
      await auth.close();
    }
  });
});

// ---- server side (gated) ----------------------------------------------------
// RoleServ (boson-chat/stack, network channels) joins guests to the
// auto-join channels on connect and accounts on their first login. Needs a
// boson stack with that RoleServ + Ergo patch and `irc.channels` set, e.g.
// in its config/boson.yaml:
//
//   irc:
//     plaintext: true
//     channels:
//       - {name: "#lobby", autojoin: true}
//
// Run (the stack's IRC on plaintext; for the account case its auth with open
// registration and no email verification, reachable from the app — a
// loopback http URL in dev/e2e builds):
//
//   E2E_NETCHAN_IRC=localhost:6667 E2E_NETCHAN_AUTH=http://127.0.0.1:8080 \
//   E2E_NETCHAN_CHANNEL='#lobby' npx playwright test -c playwright.app.config.ts network-channels
//
// Without E2E_NETCHAN_IRC they skip; without E2E_NETCHAN_AUTH the account
// case skips. The guest case also runs against the stack repo's RoleServ
// harness (fake auth, no OAUTHBEARER — so not the account case):
//
//   (stack) KEEP=1 test/roles/run.sh fake      # Ergo + RoleServ on 127.0.0.1:26667
//   curl -X POST http://127.0.0.1:28081/test/state -H 'Content-Type: application/json' \
//     -d '{"network":{"founder":"alice","autojoin_guests":true,"channels":[{"channel":"#lobby","name":"#lobby","autojoin":true}]}}'
//   E2E_NETCHAN_IRC=127.0.0.1:26667 npx playwright test -c playwright.app.config.ts network-channels -g guest
const NETCHAN_IRC = process.env['E2E_NETCHAN_IRC'] ?? '';
const NETCHAN_AUTH = (process.env['E2E_NETCHAN_AUTH'] ?? '').replace(/\/+$/, '');
const NETCHAN_CHANNEL = process.env['E2E_NETCHAN_CHANNEL'] || '#lobby';

function netchanIrc(): { host: string; port: number } {
  const i = NETCHAN_IRC.lastIndexOf(':');
  return { host: NETCHAN_IRC.slice(0, i), port: Number(NETCHAN_IRC.slice(i + 1)) };
}

test.describe('network channels: server-side auto-join (RoleServ)', () => {
  test.skip(!NETCHAN_IRC, 'set E2E_NETCHAN_IRC to a boson stack with network channels (see the comment above)');

  test(`a new guest lands in ${NETCHAN_CHANNEL} without joining it`, async ({ launchApp }) => {
    test.setTimeout(120_000);
    const irc = netchanIrc();
    const name = `Netchan guest ${uid()}`;
    const { page } = await launchApp();
    await continueAsGuest(page, `ng${uid()}`);
    // A manually added server: no listing, so no client-side auto-join.
    await addServerManually(page, { hostname: irc.host, port: irc.port, name, tls: false });
    await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
    const signIn = page.getByRole('dialog', { name: /^Sign in to / });
    // A stack with accounts asks first (when it's discoverable from here).
    await Promise.race([
      signIn.waitFor({ timeout: 15_000 }).then(() => signIn.getByRole('button', { name: 'Continue as guest' }).click()),
      expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 15_000 }),
    ]).catch(() => {});
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await expect(conversation(page, NETCHAN_CHANNEL)).toBeVisible({ timeout: 20_000 });
  });

  test(`a new account lands in ${NETCHAN_CHANNEL} on its first login, and not again after parting`, async ({ launchApp }) => {
    test.skip(!NETCHAN_AUTH, 'set E2E_NETCHAN_AUTH to that stack\'s auth service');
    test.setTimeout(180_000);
    const irc = netchanIrc();
    const name = `Netchan account ${uid()}`;
    const { page } = await launchApp({ env: { BOSON_NETWORK_JSON: bosonJson(irc, NETCHAN_AUTH) } });
    await continueAsGuest(page, `nca${uid()}`);
    await addServerManually(page, { hostname: irc.host, port: irc.port, name, tls: false });
    await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
    // A brand-new account on that network: its first login.
    const signIn = page.getByRole('dialog', { name: `Sign in to ${name}` });
    await expect(signIn).toBeVisible({ timeout: 20_000 });
    await signIn.getByRole('tab', { name: 'Create account' }).click();
    await signIn.getByPlaceholder('username', { exact: true }).fill(randomUsername('nca'));
    await signIn.getByPlaceholder('email', { exact: true }).fill(randomEmail('nca'));
    await signIn.getByPlaceholder('password', { exact: true }).fill(randomPassword());
    await signIn.getByRole('button', { name: 'Create account' }).click();
    await expect(signIn).toBeHidden({ timeout: 20_000 });
    await expectConnected(page, name);
    await expect(conversation(page, NETCHAN_CHANNEL)).toBeVisible({ timeout: 20_000 });

    // Part, reconnect (logs in again): RoleServ doesn't put us back.
    await conversation(page, NETCHAN_CHANNEL).click();
    await command(page, '/part');
    await expect(conversation(page, NETCHAN_CHANNEL)).toHaveCount(0, { timeout: 15_000 });
    await (await railContextMenu(page, name)).getByRole('menuitem', { name: 'Leave server' }).click();
    await expect(railTile(page, name)).toHaveCount(0);
    await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
    await expectConnected(page, name);
    await page.waitForTimeout(8_000);
    await expect(conversation(page, NETCHAN_CHANNEL)).toHaveCount(0);
  });
});
