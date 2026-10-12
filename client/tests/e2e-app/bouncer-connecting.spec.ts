// While ZNC is connecting to a network that's slow to answer, the app says
// "connecting" the whole time. Regression: a hosted ZNC greets every login
// with *status notices; the engine took them as "state may have changed"
// and sent a USERHOST probe, which only a registered network answers, so
// ~10s in it declared the network disconnected and offered Connect while
// ZNC was still trying.
import { test, expect, uid, continueAsGuest, configureBouncerProfile, type ZncUser } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { addZncSilentNetwork, dropExtraZncNetworks, setZncMotd } from './helpers/znc-admin';

const strip = (page: Page): Locator => page.locator('.chat-bouncer-upstream-banner');

async function attach(page: Page, z: ZncUser, network: string): Promise<void> {
  await continueAsGuest(page, `bk${uid()}`);
  await configureBouncerProfile(page, { host: z.host, port: z.port, username: z.username, password: z.password, tls: false });
  await page.getByRole('tab', { name: 'Bouncer' }).click();
  await page.getByPlaceholder('Display name').fill(network);
  await page.getByPlaceholder('ZNC network, e.g. libera').fill(network);
  await page.getByRole('button', { name: 'Add network' }).click();
  await page.locator('.directory-bouncer-row').filter({ hasText: network })
    .getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.sidebar-server-name')).toHaveText(network, { timeout: 30_000 });
}

test.describe('bouncer connecting state', () => {
  test.beforeEach(async ({ zncUser }) => { await dropExtraZncNetworks(zncUser); });
  test.afterEach(async ({ zncUser }) => {
    await setZncMotd(zncUser, []).catch(() => {});
    await dropExtraZncNetworks(zncUser);
  });

  test('a slow network shows connecting, through the login notices, not "isn\'t connected"', async ({ launchApp, zncUser }) => {
    test.setTimeout(120_000);
    const network = `slow${uid(4)}`;
    await addZncSilentNetwork(zncUser, network);
    await setZncMotd(zncUser, [
      'Welcome to Example BNC.',
      'For SSL connection use bnc.example.org:31337',
      'If you would like to get some support, mail us at support@example.org',
    ]);
    const { page } = await launchApp();
    await attach(page, zncUser, network);

    await expect(strip(page)).toHaveAttribute('data-state', 'connecting', { timeout: 30_000 });
    await expect(strip(page)).toContainText(`Your bouncer is connecting to ${network}`);
    // Past the probe delay + timeout (5s + 5s) that used to flip it.
    for (let s = 0; s < 15; s++) {
      await page.waitForTimeout(1_000);
      await expect(strip(page)).toHaveAttribute('data-state', 'connecting');
    }
    await expect(strip(page).getByRole('button', { name: 'Connect' })).toHaveCount(0);
  });
});
