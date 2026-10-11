// Bouncer flows that used to leave the user stuck:
//  - "Disconnect network" was undone by auto-connect on the next attach
//    (relaunch, reconnect): the choice now sticks until Connect network.
//  - A rejected bouncer login retried every 15s forever (fail2ban bait) with
//    no reason shown; now it stops, says why, and fixing the password in
//    User settings reconnects on its own.
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, uid, type ZncUser,
  continueAsGuest, configureBouncerProfile,
} from './fixtures';
import { railContextMenu } from './helpers/directory';
import { zncOnIrc, zncUpstream } from './helpers/znc-admin';

const strip = (page: Page): Locator => page.locator('.chat-bouncer-upstream-banner');
const dot = (page: Page): Locator => page.locator('.sidebar-status-dot');
const splashTitle = (page: Page): Locator => page.locator('.chat-engine-title');
const splashReason = (page: Page): Locator => page.locator('.chat-engine-reason');

// Directory → Bouncer tab → add the user's ZNC network → Connect.
async function addAndConnectBouncerNetwork(page: Page, z: ZncUser, name: string): Promise<void> {
  await page.getByRole('tab', { name: 'Bouncer' }).click();
  await page.getByPlaceholder('Display name').fill(name);
  await page.getByPlaceholder('ZNC network, e.g. libera').fill(z.network);
  await page.getByRole('button', { name: 'Add network' }).click();
  await page.locator('.directory-bouncer-row').filter({ hasText: name })
    .getByRole('button', { name: 'Connect', exact: true }).click();
}

test.describe('bouncer recovery', () => {
  test('Disconnect network sticks across a relaunch until Connect network', async ({ launchApp, zncUser }) => {
    const name = `ZNC Sticky ${uid(4)}`;
    let { app, page } = await launchApp();
    await continueAsGuest(page, `st${uid()}`);
    await configureBouncerProfile(page, {
      host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
    });
    await addAndConnectBouncerNetwork(page, zncUser, name);
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    expect(await zncOnIrc(zncUser)).toBe(true);

    // Take the network down, then quit.
    await (await railContextMenu(page, name)).getByRole('menuitem', { name: 'Disconnect network' }).click();
    await expect(dot(page)).toHaveAttribute('data-state', 'upstream-offline', { timeout: 30_000 });
    await expect.poll(() => zncOnIrc(zncUser), { timeout: 15_000 }).toBe(false);
    await app.close();

    // Relaunch: the app re-attaches but leaves the network down, as asked.
    ({ app, page } = await launchApp());
    await expect(page.locator('.sidebar-server-name')).toHaveText(name, { timeout: 30_000 });
    await expect(dot(page)).toHaveAttribute('data-state', 'upstream-offline', { timeout: 45_000 });
    // Auto-connect would fire ~2s after the attach burst; give it well over that.
    await page.waitForTimeout(6_000);
    await expect(strip(page)).toHaveAttribute('data-state', 'disconnected');
    expect(await zncOnIrc(zncUser)).toBe(false);

    // Connect network clears the choice…
    await strip(page).getByRole('button', { name: 'Connect' }).click();
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    expect(await zncOnIrc(zncUser)).toBe(true);
    await app.close();

    // …so a network that drops behind the app's back is auto-connected again.
    await zncUpstream(zncUser, 'disconnect');
    expect(await zncOnIrc(zncUser)).toBe(false);
    ({ page } = await launchApp());
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    expect(await zncOnIrc(zncUser)).toBe(true);
  });

  test('a rejected bouncer login stops retrying and says why; fixing the password reconnects', async ({ launchApp, zncUser }) => {
    const name = `ZNC Badpw ${uid(4)}`;
    const { page } = await launchApp();
    await continueAsGuest(page, `bp${uid()}`);
    await configureBouncerProfile(page, {
      host: zncUser.host, port: zncUser.port, username: zncUser.username, password: 'definitely-wrong', tls: false,
    });
    await addAndConnectBouncerNetwork(page, zncUser, name);

    await expect(splashReason(page)).toContainText('Your bouncer rejected the login', { timeout: 30_000 });
    await expect(splashReason(page)).toContainText('Invalid Password');
    await expect(splashTitle(page)).toHaveText(`Disconnected from ${name}`);
    // No retry cycle: still parked well past the first backoff steps.
    await page.waitForTimeout(8_000);
    await expect(splashTitle(page)).toHaveText(`Disconnected from ${name}`);

    // Fix the password: the connection re-routes by itself.
    await configureBouncerProfile(page, {
      host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
    });
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(splashReason(page)).toHaveCount(0);
  });
});
