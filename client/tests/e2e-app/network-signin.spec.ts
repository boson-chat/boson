// "Sign in to <network>": an account on a self-hosted boson network, next to
// the boson.chat one. The e2e stack runs a second network (infra/e2e:
// auth2 = its own auth service, ergo2 = the boson stack's Ergo, which takes
// no guests and logs accounts in with SASL OAUTHBEARER against auth2). The
// app finds it like a real one, from a boson.json — here handed over with
// BOSON_NETWORK_JSON for `localhost` (no real domain to serve it).
//
// Proves: sign-up and sign-in against the network's own auth service from
// the app; the IRC login with that account's token (ergo2 lets nobody in
// without it); a guest refused by the network turns into its sign-in; the
// network session survives a relaunch; the boson.chat session keeps working
// beside it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  test, expect, STACK, addServerManually, continueAsGuest, loginAs, randomEmail, randomPassword, randomUsername, serverCard, uid,
} from './fixtures';

const NET = STACK.selfhost;
const SHOTS = process.env['NETAUTH_SHOTS_DIR'] ?? '';

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
  // Let the dialog's open transition finish.
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function registerOnNetwork(): Promise<{ username: string; password: string }> {
  const username = randomUsername('net');
  const password = randomPassword();
  const res = await fetch(`${NET.auth.url}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: randomEmail('net'), password }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return { username, password };
}

async function addNetwork(page: Page, name: string): Promise<void> {
  await addServerManually(page, { hostname: NET.irc.host, port: NET.irc.port, name, tls: false });
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
}

test.describe('network sign-in', () => {
  test('sign up on a self-hosted network, log in to its IRC with that account, keep boson.chat signed in', async ({ launchApp, account }) => {
    test.setTimeout(180_000);
    const env = { BOSON_NETWORK_JSON: networkJson() };
    const name = `Selfhost ${uid()}`;
    const first = await launchApp({ env });
    const { page } = first;
    await loginAs(page, account);

    await addNetwork(page, name);
    const dialog = page.getByRole('dialog', { name: `Sign in to ${name}` });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    // Says whose server gets the password, and offers a guest connect.
    await expect(dialog.locator('.netauth-realm-host')).toHaveText(new URL(NET.auth.url).host);
    await expect(dialog.getByRole('button', { name: 'Continue as guest' })).toBeVisible();
    await shot(page, '01-connect-dialog');

    const username = randomUsername('net');
    await dialog.getByRole('tab', { name: 'Create account' }).click();
    await dialog.getByPlaceholder('username', { exact: true }).fill(username);
    await dialog.getByPlaceholder('email', { exact: true }).fill(randomEmail('net'));
    await dialog.getByPlaceholder('password', { exact: true }).fill(randomPassword());
    await shot(page, '02-create-account');
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    // ergo2 takes no guests: connected means the OAUTHBEARER login worked.
    await expect(page.locator('.sidebar-server-name')).toHaveText(name, { timeout: 30_000 });
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await expect(page.locator('.netauth-bar')).toContainText(`${username} on ${name}`);
    await shot(page, '03-connected-with-network-account');

    // Settings: the network account beside the boson.chat one, which still
    // works (its account details load from the boson API with its token).
    await page.getByRole('button', { name: 'User settings' }).click();
    const settings = page.getByRole('dialog', { name: 'User settings' });
    await settings.getByRole('tab', { name: /Network accounts/ }).click();
    await expect(settings.getByText(username, { exact: false })).toBeVisible();
    await expect(settings.getByText('Signed in', { exact: true })).toBeVisible();
    await shot(page, '04-settings-network-accounts');
    await settings.getByRole('tab', { name: /^Account/ }).click();
    await expect(settings.getByText(account.email)).toBeVisible();
    await settings.getByRole('button', { name: 'Close' }).click();

    // A relaunch restores both sessions and logs in to the network again.
    const appUrl = new URL(page.url()).origin;
    await first.app.close();
    // The relaunch reuses the profile's port: wait until the old app let go.
    await expect.poll(async () => {
      try { await fetch(`${appUrl}/health`, { signal: AbortSignal.timeout(1_000) }); return 'up'; } catch { return 'gone'; }
    }, { timeout: 15_000 }).toBe('gone');
    const again = await launchApp({ env });
    await expect(again.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(again.page.locator('.netauth-bar')).toContainText(`${username} on`);
  });

  test("a guest the network refuses gets the network's sign-in, and gets in with an account", async ({ launchApp }) => {
    test.setTimeout(180_000);
    const user = await registerOnNetwork();
    const name = `Selfhost ${uid()}`;
    const { page } = await launchApp({ env: { BOSON_NETWORK_JSON: networkJson() } });
    await continueAsGuest(page, `g${uid()}`);

    await addNetwork(page, name);
    const dialog = page.getByRole('dialog', { name: `Sign in to ${name}` });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Continue as guest' }).click();

    // ergo2 refuses the guest (FAIL ACCOUNT_REQUIRED): the sign-in comes
    // back, this time without a guest way in.
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator('.netauth-required')).toContainText('requires an account');
    await expect(dialog.getByRole('button', { name: 'Continue as guest' })).toHaveCount(0);
    await shot(page, '05-guest-refused');

    await dialog.getByPlaceholder('username or email', { exact: true }).fill(user.username);
    await dialog.getByPlaceholder('password', { exact: true }).fill(user.password);
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await expect(page.locator('.netauth-bar')).toContainText(`${user.username} on ${name}`);
  });
});
