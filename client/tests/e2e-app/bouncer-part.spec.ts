// Parting a channel through a bouncer leaves it for every client: another
// client of the same ZNC network parts it, and the app drops it at once if
// it's attached, or (if it was closed at the time) doesn't join it again on
// its next attach. Rejoining it would undo the part on the bouncer and on
// every other client.
import type { Locator, Page } from '@playwright/test';
import { test, expect, uid, IRC_HOST, IRC_PORT, type ZncUser, continueAsGuest, configureBouncerProfile, joinChannel } from './fixtures';
import { IrcPeer } from './irc-peer';

const dot = (page: Page): Locator => page.locator('.sidebar-status-dot');
const channelRow = (page: Page, ch: string): Locator =>
  page.getByRole('complementary', { name: 'Channels' }).locator('.channel-item').filter({ hasText: ch.slice(1) });

async function attachBouncerNetwork(page: Page, z: ZncUser, name: string): Promise<void> {
  await page.getByRole('tab', { name: 'Bouncer' }).click();
  await page.getByPlaceholder('Display name').fill(name);
  await page.getByPlaceholder('ZNC network, e.g. libera').fill(z.network);
  await page.getByRole('button', { name: 'Add network' }).click();
  await page.locator('.directory-bouncer-row').filter({ hasText: name })
    .getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
}

// Another client of the same ZNC user + network (a second device).
const otherClient = (z: ZncUser): Promise<IrcPeer> => IrcPeer.connect({
  host: z.host, port: z.port, nick: `oc${uid(4)}`, pass: `${z.username}/${z.network}:${z.password}`,
});

test.describe('parting through a bouncer', () => {
  test('a part from another client drops the channel here, live and after a relaunch', async ({ launchApp, zncUser }) => {
    const keep = `#keep${uid(5)}`;
    const live = `#live${uid(5)}`;
    const away = `#away${uid(5)}`;
    // On the network itself: sees the bouncer's JOINs.
    const watcher = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `w${uid(5)}` });
    for (const ch of [keep, live, away]) await watcher.join(ch);

    let { app, page } = await launchApp();
    await continueAsGuest(page, `bp${uid()}`);
    await configureBouncerProfile(page, {
      host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
    });
    await attachBouncerNetwork(page, zncUser, `ZNC Part ${uid(4)}`);
    for (const ch of [keep, live, away]) {
      await joinChannel(page, ch);
      await expect(channelRow(page, ch)).toBeVisible({ timeout: 30_000 });
    }

    // Parted on another device while this one is attached: gone here too.
    const other = await otherClient(zncUser);
    other.send(`PART ${live} :done here`);
    await expect(channelRow(page, live)).toHaveCount(0, { timeout: 15_000 });
    await expect(channelRow(page, keep)).toBeVisible();

    // Parted on another device while this one is closed: not joined again.
    await app.close();
    other.send(`PART ${away} :done here too`);
    await other.waitFor((l) => l.command === 'PART' && (l.params[0] ?? '').toLowerCase() === away.toLowerCase(), 15_000, 'PART echo');
    await other.quit();
    const mark = watcher.mark();
    ({ app, page } = await launchApp());
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(channelRow(page, keep)).toBeVisible({ timeout: 30_000 });
    // The restore joins what's missing ~4s after the bouncer's JOINs go quiet.
    await page.waitForTimeout(8_000);
    await expect(channelRow(page, away)).toHaveCount(0);
    await expect(channelRow(page, live)).toHaveCount(0);
    const rejoined = watcher.lines.slice(mark).filter((l) => l.command === 'JOIN'
      && [away, live].map((c) => c.toLowerCase()).includes((l.params[0] ?? '').toLowerCase()));
    expect(rejoined.map((l) => l.raw)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('after-relaunch.png') });
    await watcher.quit();
    await app.close();
  });
});
