// Startup loads that fail once must not need a relaunch. On launch / sign-in
// the app fetches the profile (/me) and the synced session (/me/session);
// if the network isn't up yet (a laptop just woke, Wi-Fi still joining) or
// the API blips, those requests fail. The app has to keep trying and bring
// the servers + channels (and the directory) back on its own once the API
// answers again — before, it stayed on "Reconnecting…" or an empty list
// until the user quit and reopened it.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  test as base, expect, IRC_HOST, IRC_PORT,
  joinChannel, loginAs, randomChannel, randomNick, seedServer, serverCard,
  type Account, type DirectoryServer, type LaunchedApp, type Profile,
} from './fixtures';
import { controlApi } from './helpers/directory';
import { IrcPeer } from './irc-peer';

const test = base.extend<{ otherDevice: Profile }>({
  // eslint-disable-next-line no-empty-pattern
  otherDevice: async ({}, use) => {
    const root = mkdtempSync(join('/tmp', 'boson-e2e-'));
    const p = { root, home: join(root, 'home'), runtime: join(root, 'run'), userData: join(root, 'userData') };
    for (const d of [p.home, p.runtime, p.userData]) mkdirSync(d, { recursive: true, mode: 0o700 });
    await use(p);
    rmSync(root, { recursive: true, force: true });
  },
});

// How long the API stays down after launch: long enough that every startup
// request has failed (the proxy fails them at once), short for the suite.
const OUTAGE_MS = 4_000;

// Device A: sign in, connect to a seeded server, join `channel`, wait for the
// session to sync, quit. Returns the server.
async function setUpSession(
  launchApp: (opts?: { profile?: Profile; env?: Record<string, string> }) => Promise<LaunchedApp>,
  account: Account, peer: IrcPeer, channel: string,
): Promise<DirectoryServer> {
  const seeded = await seedServer({ description: 'Seeded by startup-load.spec' });
  const a = await launchApp();
  expect(await loginAs(a.page, account)).toBe('directory');
  await a.page.getByPlaceholder('Search servers…').fill(seeded.name);
  await serverCard(a.page, seeded.name).getByRole('button', { name: 'Connect' }).click();
  await expect(a.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  await joinChannel(a.page, channel);
  await peer.waitForJoin(channel, account.handle!);
  // Debounced push of the saved session.
  await expect.poll(() => a.page.evaluate(() => localStorage.getItem('boson:session:v2') ?? ''), { timeout: 15_000 })
    .toContain(channel);
  await a.page.waitForTimeout(2_000);
  await a.app.close();
  return seeded;
}

async function expectRestored(page: Page, server: DirectoryServer, channel: string, timeout = 45_000): Promise<void> {
  await expect(page.locator('.sidebar-server-name')).toHaveText(server.name, { timeout });
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  await expect(
    page.getByRole('complementary', { name: 'Channels' }).getByText(channel.replace(/^#/, ''), { exact: true }),
  ).toBeVisible({ timeout: 30_000 });
}

function joinedFrom(peer: IrcPeer, account: Account, channel: string, mark: number, what: string): Promise<unknown> {
  return peer.waitFor(
    (l) => l.command === 'JOIN' && l.prefix.split('!')[0] === account.handle &&
      (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
    60_000, what, mark,
  );
}

for (const [label, down] of [
  ['the whole API is unreachable', '1'],
  ['only the profile (/me) fails', '/me'],
] as const) {
  test(`relaunch while ${label}: servers + channels come back on their own`, async ({ launchApp, account, profile }) => {
    test.setTimeout(240_000);
    const channel = randomChannel('boot');
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('peer') });
    try {
      await peer.join(channel);
      const server = await setUpSession(launchApp, account, peer, channel);

      const mark = peer.mark();
      const b = await launchApp({ profile, env: { BOSON_E2E_API_DOWN: down } });
      const api = controlApi(b.app);
      await b.page.waitForTimeout(OUTAGE_MS);
      await api.setDown(false);
      // No relaunch, no clicks.
      await expectRestored(b.page, server, channel);
      await joinedFrom(peer, account, channel, mark, `${account.handle} rejoining ${channel} after the outage`);
    } finally {
      await peer.quit();
    }
  });
}

test('sign in while the synced session fails to load: it loads once the API recovers', async ({ launchApp, account, otherDevice }) => {
  test.setTimeout(240_000);
  const channel = randomChannel('boot');
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('peer') });
  try {
    await peer.join(channel);
    const server = await setUpSession(launchApp, account, peer, channel);

    // A fresh device: nothing local, so the servers can only come from /me/session.
    const mark = peer.mark();
    const b = await launchApp({ profile: otherDevice, env: { BOSON_E2E_API_DOWN: '/me/session' } });
    expect(await loginAs(b.page, account)).toBe('directory');
    await b.page.waitForTimeout(OUTAGE_MS);
    await controlApi(b.app).setDown(false);
    await expectRestored(b.page, server, channel);
    await joinedFrom(peer, account, channel, mark, `${account.handle} joining ${channel} on the new device`);
  } finally {
    await peer.quit();
  }
});

test('the directory list loads once the API recovers', async ({ launchApp, account }) => {
  const seeded = await seedServer({ description: 'Seeded by startup-load.spec (directory)' });
  const a = await launchApp();
  expect(await loginAs(a.page, account)).toBe('directory');
  await a.app.close();

  const b = await launchApp({ env: { BOSON_E2E_API_DOWN: '1' } });
  await b.page.waitForTimeout(OUTAGE_MS);
  await controlApi(b.app).setDown(false);
  await b.page.getByPlaceholder('Search servers…').fill(seeded.name, { timeout: 45_000 });
  await expect(serverCard(b.page, seeded.name)).toBeVisible({ timeout: 30_000 });
  await expect(b.page.getByText("Couldn't load directory")).toBeHidden();
});
