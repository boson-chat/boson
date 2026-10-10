// The Boson nick-claim flow for signed-in users, end to end: Server settings
// → Identity → "Claim <handle> on this network" → the backend mints a claim
// with a reg+<user>-<token>@boson.chat recipient → the app REGISTERs with it
// on ergo → ergo mails the code to the catch-all → the backend's POP3 worker
// captures it → the app polls GET /me/nick-claims/{id} and VERIFYs. The
// generated password is then synced (E2E-encrypted) to the backend and
// identifies a second device on connect.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  test, expect, IRC_HOST, IRC_PORT, field, loginAs, randomNick, seedServer, serverCard, backendSql, uid,
  type Profile,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import type { Page } from '@playwright/test';
import {
  accountBadge, expectConnected, expectWhoisAccount, openServerSettings, preregisterAccount, servicesBadge,
} from './helpers/services';

interface SecretsList { secrets: Array<{ server_id: string; ciphertext: string; updated_at: string }> }

function extraProfile(): Profile {
  const root = mkdtempSync('/tmp/boson-e2e-');
  const p = { root, home: join(root, 'home'), runtime: join(root, 'run'), userData: join(root, 'userData') };
  for (const d of [p.home, p.runtime, p.userData]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return p;
}

test('signed-in user claims their handle via the backend; the password syncs E2E-encrypted and identifies a second device', async ({ launchApp, account, backendApi }) => {
  test.setTimeout(180_000);
  const seeded = await seedServer({ description: 'Seeded by services-claim.spec' });
  const nick = account.handle!;
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('obs') });
  const second = extraProfile();
  try {
    // ---- device 1: sign in, connect, claim ----
    const first = await launchApp();
    expect(await loginAs(first.page, account)).toBe('directory');
    await first.page.getByPlaceholder('Search servers…').fill(seeded.name);
    await serverCard(first.page, seeded.name).getByRole('button', { name: 'Connect' }).click();
    await expectConnected(first.page);

    const settings = await openServerSettings(first.page, 'Identity');
    await expect(servicesBadge(settings)).toHaveText('Ergo (built-in)', { timeout: 20_000 });
    await expect(settings.getByText('Saved here syncs (end-to-end encrypted) to your Boson account', { exact: false })).toBeVisible();
    await settings.getByRole('button', { name: `Claim ${nick} on this network` }).click();
    await expect(settings.getByRole('button', { name: `Claiming ${nick} on this network…` })).toBeVisible();

    // The backend minted the claim for this server + nick…
    await expect.poll(() => backendSql(
      `select count(*) from nick_claims c join users u on u.id = c.user_id where u.handle = '${nick}' and c.server_id = '${seeded.id}' and c.account_nick = '${nick}'`,
    )).toBe('1');

    // …and the whole dance completes without any further input.
    await expect(settings.getByRole('status').filter({ hasText: `Claimed ${nick}.` })).toBeVisible({ timeout: 60_000 });
    await expect(accountBadge(settings)).toHaveText('Identified');
    await expectWhoisAccount(peer, nick, nick);
    // The POP3 worker captured the code from the mail and the app consumed it.
    expect(backendSql(
      `select c.status || ':' || (c.code is not null) || ':' || (c.mail_uid is not null) from nick_claims c join users u on u.id = c.user_id where u.handle = '${nick}'`,
    )).toBe('consumed:true:true');

    // The generated password is revealed once (field switched to text).
    const pwField = field(settings, 'Password');
    await expect(pwField).toHaveAttribute('type', 'text');
    const generated = await pwField.inputValue();
    expect(generated.length).toBeGreaterThanOrEqual(16);
    // Email is the claim's reg+ recipient.
    await expect(field(settings, 'Email')).toHaveValue(/^reg\+[a-f0-9]{32}-[a-z0-9]{8}@boson\.chat$/);

    // ---- synced to the backend, encrypted ----
    const api = await backendApi(account);
    let secret: SecretsList['secrets'][number] | undefined;
    await expect.poll(async () => {
      secret = (await api.get<SecretsList>('/me/nickserv-secrets')).secrets.find((s) => s.server_id === seeded.id);
      return secret !== undefined;
    }, { timeout: 15_000 }).toBe(true);
    const blob = Buffer.from(secret!.ciphertext, 'base64');
    expect(blob.length).toBeGreaterThan(generated.length);
    expect(blob.toString('latin1')).not.toContain(generated);
    expect(secret!.ciphertext).not.toContain(Buffer.from(generated).toString('base64').slice(0, 12));

    await first.app.close();
    await expectWhoisAccount(peer, nick, null);

    // ---- device 2: fresh profile, sign in → the synced password identifies ----
    const dev2 = await launchApp({ profile: second });
    try {
      expect(await loginAs(dev2.page, account)).toBe('directory');
      // The cloud-saved session may already have reconnected the server.
      if (!(await dev2.page.locator('.sidebar-status-dot').isVisible())) {
        await dev2.page.getByPlaceholder('Search servers…').fill(seeded.name);
        await serverCard(dev2.page, seeded.name).getByRole('button', { name: 'Connect' }).click();
      }
      await expectConnected(dev2.page);
      const s2 = await openServerSettings(dev2.page, 'Identity');
      await expect(field(s2, 'Password')).toHaveValue(generated);
      await expectWhoisAccount(peer, nick, nick, 30_000);
      await expect(accountBadge(s2)).toHaveText('Identified');

      // Clearing the saved credentials removes the synced copy too.
      await s2.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect(field(s2, 'Password')).toHaveValue('');
      await expect.poll(async () => (await api.get<SecretsList>('/me/nickserv-secrets')).secrets
        .some((x) => x.server_id === seeded.id), { timeout: 15_000 }).toBe(false);
    } finally {
      await dev2.app.close();
    }
  } finally {
    await peer.quit();
    rmSync(second.root, { recursive: true, force: true });
  }
});

async function signInAndConnect(page: Page, account: { email: string; password: string }, serverName: string): Promise<void> {
  expect(await loginAs(page, account)).toBe('directory');
  await page.getByPlaceholder('Search servers…').fill(serverName);
  await serverCard(page, serverName).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page);
}

test('claiming a handle that is already registered on the network fails cleanly', async ({ launchApp, account }) => {
  const seeded = await seedServer({ description: 'Seeded by services-claim.spec' });
  const nick = account.handle!;
  await preregisterAccount(nick, `pw-${uid(10)}`);
  const { page } = await launchApp();
  await signInAndConnect(page, account, seeded.name);

  const settings = await openServerSettings(page, 'Identity');
  await settings.getByRole('button', { name: `Claim ${nick} on this network` }).click();
  await expect(settings.getByRole('alert').filter({ hasText: `${nick} is already registered on this network.` })).toBeVisible();
  // Nothing was stored: no generated password, the Claim button is back.
  await expect(field(settings, 'Password')).toHaveValue('');
  await expect(settings.getByRole('button', { name: `Claim ${nick} on this network` })).toBeVisible();
});

test('a running claim can be cancelled', async ({ launchApp, account }) => {
  const seeded = await seedServer({ description: 'Seeded by services-claim.spec' });
  const nick = account.handle!;
  const { page } = await launchApp();
  await signInAndConnect(page, account, seeded.name);

  const settings = await openServerSettings(page, 'Identity');
  await settings.getByRole('button', { name: `Claim ${nick} on this network` }).click();
  await expect(settings.getByRole('button', { name: `Claiming ${nick} on this network…` })).toBeVisible();
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings.getByRole('button', { name: `Claim ${nick} on this network` })).toBeVisible();
  await expect(settings.getByRole('status').filter({ hasText: 'Claimed' })).toHaveCount(0);
  await expect(field(settings, 'Password')).toHaveValue('');
});
