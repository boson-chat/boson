// Reopening the app comes back to the channel this device last had open —
// not to the one another device of the same account was on. The account's
// synced session (/me/session) carries the servers and channels to every
// device, and each device's pushes carry its own place in them too; a
// relaunch used to adopt that copy whole, landing wherever the last device
// to push had been.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  test as base, expect, IRC_HOST, IRC_PORT,
  composer, joinChannel, loginAs, randomChannel, randomNick, seedServer, serverCard,
  type Profile,
} from './fixtures';
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

interface SyncedSession { payload: { servers?: Array<{ activeChannel: string | null }> } | null }

test('a relaunch returns to this device\'s last channel, not another device\'s', async ({ launchApp, otherDevice, account, backendApi }) => {
  test.setTimeout(240_000);
  const seeded = await seedServer({ description: 'Seeded by restore-last-channel.spec' });
  const mine = randomChannel('mine');
  const theirs = randomChannel('theirs');
  const api = await backendApi(account);
  const syncedActive = async (): Promise<string | null> =>
    (await api.get<SyncedSession>('/me/session')).payload?.servers?.[0]?.activeChannel ?? null;
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('peer') });
  try {
    await peer.join(mine);
    await peer.join(theirs);

    // ---- device A (the phone): two channels, reading `mine` ----
    const a = await launchApp();
    expect(await loginAs(a.page, account)).toBe('directory');
    await a.page.getByPlaceholder('Search servers…').fill(seeded.name);
    await serverCard(a.page, seeded.name).getByRole('button', { name: 'Connect' }).click();
    await expect(a.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await joinChannel(a.page, mine);
    await joinChannel(a.page, theirs);
    await a.page.getByRole('complementary', { name: 'Channels' }).getByText(mine.replace(/^#/, ''), { exact: true }).click();
    await expect(composer(a.page, mine)).toBeVisible();
    await expect.poll(syncedActive, { timeout: 15_000 }).toBe(mine.toLowerCase());
    await a.app.close();

    // ---- device B (the desktop): same account, reading `theirs` ----
    const b = await launchApp({ profile: otherDevice });
    expect(await loginAs(b.page, account)).toBe('directory');
    await expect(b.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    const bChannels = b.page.getByRole('complementary', { name: 'Channels' });
    await expect(bChannels.getByText(theirs.replace(/^#/, ''), { exact: true })).toBeVisible({ timeout: 30_000 });
    await bChannels.getByText(theirs.replace(/^#/, ''), { exact: true }).click();
    await expect(composer(b.page, theirs)).toBeVisible();
    await expect.poll(syncedActive, { timeout: 15_000 }).toBe(theirs.toLowerCase());
    await b.app.close();

    // ---- device A reopened: back on `mine` ----
    const a2 = await launchApp();
    await expect(a2.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(composer(a2.page, mine)).toBeVisible({ timeout: 30_000 });
    // And it stays there once every channel has joined (not swapped for
    // whichever joined last).
    await expect(
      a2.page.getByRole('complementary', { name: 'Channels' }).getByText(theirs.replace(/^#/, ''), { exact: true }),
    ).toBeVisible();
    await a2.page.waitForTimeout(5_000);
    await expect(composer(a2.page, mine)).toBeVisible();
    await expect(composer(a2.page, theirs)).toHaveCount(0);
  } finally {
    await peer.quit();
  }
});
