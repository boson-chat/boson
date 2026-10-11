// A bouncer that won't accept the network's TLS certificate. ZNC drops the
// upstream, dumps the certificate into *status, asks for
// `/znc AddTrustedServerFingerprint <sha256>` and retries every few seconds.
// The app turns that into a strip with Trust certificate / Don't trust,
// against a real ZNC network pointed at ergo's self-signed TLS listener.
import { test, expect, uid, continueAsGuest, configureBouncerProfile, type ZncUser } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { addZncTlsNetwork, dropExtraZncNetworks, zncOnIrc } from './helpers/znc-admin';

const strip = (page: Page): Locator => page.locator('.chat-bouncer-upstream-banner');
const dot = (page: Page): Locator => page.locator('.sidebar-status-dot');

// Guest + bouncer profile, then attach the ZNC network `network` from the
// Directory's Bouncer tab. Auto-connect is on, so ZNC tries the network
// straight away and trips over the certificate.
async function attach(page: Page, z: ZncUser, network: string): Promise<void> {
  await continueAsGuest(page, `bc${uid()}`);
  await configureBouncerProfile(page, { host: z.host, port: z.port, username: z.username, password: z.password, tls: false });
  await page.getByRole('tab', { name: 'Bouncer' }).click();
  await page.getByPlaceholder('Display name').fill(network);
  await page.getByPlaceholder('ZNC network, e.g. libera').fill(network);
  await page.getByRole('button', { name: 'Add network' }).click();
  await page.locator('.directory-bouncer-row').filter({ hasText: network })
    .getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.sidebar-server-name')).toHaveText(network, { timeout: 30_000 });
}

async function onIrc(z: ZncUser, network: string): Promise<boolean> {
  return zncOnIrc({ ...z, network });
}

test.describe('bouncer certificate prompt', () => {
  test.beforeEach(async ({ zncUser }) => { await dropExtraZncNetworks(zncUser); });
  test.afterEach(async ({ zncUser }) => { await dropExtraZncNetworks(zncUser); });

  test('Trust certificate pins the fingerprint and the bouncer gets on the network', async ({ launchApp, zncUser }) => {
    const network = `tls${uid(4)}`;
    await addZncTlsNetwork(zncUser, network);
    const { page } = await launchApp();
    await attach(page, zncUser, network);

    await expect(strip(page)).toHaveAttribute('data-state', 'certificate', { timeout: 30_000 });
    await expect(strip(page)).toContainText(`Your bouncer doesn't trust ${network}'s certificate`);
    await expect(strip(page)).toContainText(/SHA-256 ([0-9a-f]{2}:){31}[0-9a-f]{2}/);
    await expect(page.locator('.chat-bouncer-upstream-banner').getByRole('button', { name: 'Connect' })).toHaveCount(0);

    await strip(page).getByRole('button', { name: 'Trust certificate' }).click();
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(strip(page)).toBeHidden();
    await expect.poll(() => onIrc(zncUser, network), { timeout: 15_000 }).toBe(true);
  });

  test("Don't trust stops the bouncer retrying and leaves Connect on offer", async ({ launchApp, zncUser }) => {
    const network = `tls${uid(4)}`;
    await addZncTlsNetwork(zncUser, network);
    const { page } = await launchApp();
    await attach(page, zncUser, network);

    await expect(strip(page)).toHaveAttribute('data-state', 'certificate', { timeout: 30_000 });
    await strip(page).getByRole('button', { name: "Don't trust" }).click();
    await expect(strip(page)).toHaveAttribute('data-state', 'disconnected');
    await expect(strip(page)).toContainText("Your bouncer isn't connected to");
    // ZNC has given up rather than retrying (ServerThrottle is 1s in the
    // e2e znc.conf): the prompt doesn't come back on its own.
    await page.waitForTimeout(4_000);
    await expect(strip(page)).toHaveAttribute('data-state', 'disconnected');
    expect(await onIrc(zncUser, network)).toBe(false);

    // Connect asks again: nothing was trusted.
    await strip(page).getByRole('button', { name: 'Connect' }).click();
    await expect(strip(page)).toHaveAttribute('data-state', 'certificate', { timeout: 30_000 });
  });
});
