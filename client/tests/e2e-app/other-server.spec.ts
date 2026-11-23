// "Use another server" on the login screen: sign up on a self-hosted boson
// network straight from a fresh launch, with no boson.chat account. The e2e
// stack's second network (auth2 + ergo2, which takes no guests) is found
// from its boson.json, handed over with BOSON_NETWORK_JSON for `localhost`
// (see network-signin.spec.ts).
//
// Proves: the address is resolved to the network (its name, what it
// offers, who sees the password); signing up there lands in the app in
// guest mode for boson.chat with ergo2 added and connected with the new
// account (ergo2 lets nobody in without it); the account is listed under
// Network accounts; a relaunch restores the connection; and leaving guest
// mode signs out of it all (nothing is offered to the next person).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, STACK, randomEmail, randomPassword, randomUsername, IS_WEB } from './fixtures';

const NET = STACK.selfhost;
const SHOTS = process.env['OTHERSERVER_SHOTS_DIR'] ?? '';

function networkJson(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boson-net-'));
  const file = join(dir, 'boson.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    irc: { host: NET.irc.host, port: NET.irc.port, tls: false },
    auth: { url: NET.auth.url },
  }));
  return file;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test.describe('use another server', () => {
  test('sign up on a self-hosted network from the login screen and land connected to it', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const env = { BOSON_NETWORK_JSON: networkJson() };
    const first = await launchApp({ env });
    const { page } = first;

    // Fresh launch: the boson.chat login, with the server switch.
    await expect(page.locator('.login-server-host')).toHaveText('boson.chat', { timeout: 20_000 });
    await shot(page, '01-login-server-line');
    await page.getByRole('button', { name: 'Use another server' }).click();
    await page.getByLabel('Server address').fill('nothing-here.invalid');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    // A name with no DNS record is a typo, not an IRC server (the desktop
    // shell looks the name up; the web one can't, and says both).
    await expect(page.getByRole('alert')).toContainText(/Couldn't find nothing-here\.invalid\. Check the spelling|Couldn't reach nothing-here\.invalid as a Boson network/, { timeout: 15_000 });
    await shot(page, '02-not-found');

    await page.getByLabel('Server address').fill(NET.irc.host);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const about = page.locator('.otherserver-network');
    await expect(about).toBeVisible({ timeout: 15_000 });
    // What it offers, from its /v1/config (auth2 doesn't say no guests:
    // ergo2 refuses them itself — network-signin.spec.ts).
    await expect(about.locator('.otherserver-facts')).toContainText('Open sign-up');
    await expect(page.locator('.netauth-realm-host')).toHaveText(new URL(NET.auth.url).host);
    await expect(page.getByRole('button', { name: /^Continue as guest on / })).toBeVisible();
    await shot(page, '03-network-sign-in');

    const username = randomUsername('oth');
    await page.getByRole('tab', { name: 'Create account' }).click();
    await page.getByPlaceholder('username', { exact: true }).fill(username);
    await page.getByPlaceholder('email', { exact: true }).fill(randomEmail('oth'));
    await page.getByPlaceholder('password', { exact: true }).fill(randomPassword());
    await shot(page, '04-create-account');
    await page.getByRole('button', { name: 'Create account' }).click();

    // In the app, connected to ergo2 with the new account (OAUTHBEARER).
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(page.locator('.netauth-bar')).toContainText(`${username} on`);
    await shot(page, '05-connected');

    // Network accounts lists it; Account says there's no boson.chat account.
    await page.getByRole('button', { name: 'User settings' }).click();
    const settings = page.getByRole('dialog', { name: 'User settings' });
    await settings.getByRole('tab', { name: /Network accounts/ }).click();
    await expect(settings.getByText(username, { exact: false })).toBeVisible();
    // Named as on the login screen, not after its sign-in service's host.
    await expect(settings.getByRole('list', { name: 'Network accounts' }).locator('.bds-row-title').first()).toHaveText(/^localhost/);
    await expect(settings.getByText('Signed in', { exact: true })).toBeVisible();
    await shot(page, '06-settings-network-accounts');
    await settings.getByRole('tab', { name: /^Account/ }).click();
    await expect(settings.getByText(/without a boson\.chat account/)).toBeVisible();
    await settings.getByRole('button', { name: 'Close' }).click();

    // A relaunch restores the network session and logs in to ergo2 again.
    const appUrl = new URL(page.url()).origin;
    await first.app.close();
    // (The web build's page server stays up: nothing to wait for.)
    if (!IS_WEB) {
      await expect.poll(async () => {
        try { await fetch(`${appUrl}/health`, { signal: AbortSignal.timeout(1_000) }); return 'up'; } catch { return 'gone'; }
      }, { timeout: 15_000 }).toBe('gone');
    }
    const again = await launchApp({ env });
    const p2 = again.page;
    await expect(p2.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(p2.locator('.netauth-bar')).toContainText(`${username} on`);

    // Leaving guest mode is a full sign-out: the network's session and
    // its server go too, so the login screen doesn't offer to continue as
    // that user (the next person on this device starts clean).
    await p2.getByRole('button', { name: 'User settings' }).click();
    const s2 = p2.getByRole('dialog', { name: 'User settings' });
    await s2.getByRole('tab', { name: /^Account/ }).click();
    await s2.getByRole('button', { name: 'Switch to an account' }).click();
    await expect(p2.locator('.login-screen')).toBeVisible({ timeout: 30_000 });
    await expect(p2.locator('.login-server-host')).toHaveText('boson.chat');
    await shot(p2, '07-login-after-guest');
    await p2.waitForTimeout(2_000);
    await expect(p2.getByRole('button', { name: /^Continue to / })).toHaveCount(0);
    const left = await p2.evaluate(() => Object.keys(localStorage).filter((k) => /^(boson:guest:|boson\.netauth\.|boson\.login\.|boson:local-servers:)/.test(k)));
    expect(left).toEqual([]);
  });
});
