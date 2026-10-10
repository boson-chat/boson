// Settings that follow the account to another device: the E2E-encrypted
// global bouncer profile (/me/bouncer) and the saved session — servers +
// joined channels (/me/session). "Another device" is a second app profile
// (its own HOME, userData and keychain) signed in as the same user.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  test as base, expect, IRC_HOST, IRC_PORT,
  composer, field, joinChannel, loginAs, randomChannel, randomNick, seedServer, sendMessage, serverCard, uid,
  type Profile,
} from './fixtures';
import { IrcPeer } from './irc-peer';

// A second throwaway profile = a second device.
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

async function openBouncerSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: /^Bouncer/ }).click();
  return dialog;
}

interface BouncerBlob { bouncer: { ciphertext: string; updated_at: string } | null }

test('the bouncer profile syncs end-to-end encrypted to a second device, and edits flow back', async ({ launchApp, otherDevice, account, backendApi }) => {
  const api = await backendApi(account);
  const host = `znc-${uid()}.example.test`;
  const username = `u${uid()}`;
  const password = `secret-${uid(10)}`;

  // ---- device A: save a profile ----
  const a = await launchApp();
  expect(await loginAs(a.page, account)).toBe('directory');
  let dialog = await openBouncerSettings(a.page);
  await expect(dialog.getByText('Sign in to sync this bouncer', { exact: false })).toBeHidden();
  await dialog.getByText('Use a bouncer', { exact: true }).click();
  await field(dialog, 'Host').fill(host);
  await field(dialog, 'Port').fill('7000');
  await field(dialog, 'Username').fill(username);
  await field(dialog, 'Password').fill(password);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();

  // Pushed (debounced) as ciphertext only: nothing readable reaches Boson.
  await expect.poll(async () => (await api.get<BouncerBlob>('/me/bouncer')).bouncer?.ciphertext ?? null, { timeout: 15_000 })
    .not.toBeNull();
  const blob = (await api.get<BouncerBlob>('/me/bouncer')).bouncer!;
  const raw = Buffer.from(blob.ciphertext, 'base64').toString('latin1');
  for (const plain of [host, username, password]) {
    expect(blob.ciphertext).not.toContain(plain);
    expect(raw).not.toContain(plain);
  }
  await a.app.close();

  // ---- device B: signs in, the profile arrives decrypted ----
  const b = await launchApp({ profile: otherDevice });
  expect(await loginAs(b.page, account)).toBe('directory');
  dialog = await openBouncerSettings(b.page);
  await expect(field(dialog, 'Host')).toHaveValue(host, { timeout: 15_000 });
  await expect(field(dialog, 'Port')).toHaveValue('7000');
  await expect(field(dialog, 'Username')).toHaveValue(username);
  await expect(field(dialog, 'Password')).toHaveValue(password);
  await expect(dialog.getByRole('checkbox', { name: 'Use a bouncer', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Use TLS', exact: true })).toBeChecked();

  // Edit on B → pushed with a newer timestamp.
  const username2 = `u${uid()}`;
  await field(dialog, 'Username').fill(username2);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
  await expect.poll(async () => (await api.get<BouncerBlob>('/me/bouncer')).bouncer?.ciphertext, { timeout: 15_000 })
    .not.toBe(blob.ciphertext);
  await b.app.close();

  // ---- device A again: the restore-on-launch unlock pulls B's edit ----
  const a2 = await launchApp();
  await expect(a2.page.getByRole('heading', { name: 'Server Directory' })).toBeVisible({ timeout: 45_000 });
  dialog = await openBouncerSettings(a2.page);
  await expect(field(dialog, 'Username')).toHaveValue(username2, { timeout: 15_000 });
  await expect(field(dialog, 'Host')).toHaveValue(host);

  // Clearing it removes the remote copy too.
  await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(field(dialog, 'Host')).toHaveValue('');
  await expect.poll(async () => (await api.get<BouncerBlob>('/me/bouncer')).bouncer, { timeout: 15_000 }).toBeNull();
});

test('servers and channels joined on one device are restored on a second one, even after the first signs out', async ({ launchApp, otherDevice, account, backendApi }) => {
  test.setTimeout(180_000);
  const seeded = await seedServer({ description: 'Seeded by account-sync.spec' });
  const channel = randomChannel('sync');
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('peer') });
  try {
    await peer.join(channel);

    // ---- device A: connect + join ----
    const a = await launchApp();
    expect(await loginAs(a.page, account)).toBe('directory');
    await a.page.getByPlaceholder('Search servers…').fill(seeded.name);
    await serverCard(a.page, seeded.name).getByRole('button', { name: 'Connect' }).click();
    await expect(a.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await joinChannel(a.page, channel);
    await peer.waitForJoin(channel, account.handle!);

    // The saved session reached the backend.
    const api = await backendApi(account);
    await expect.poll(async () => JSON.stringify((await api.get<{ payload: unknown }>('/me/session')).payload ?? null), { timeout: 15_000 })
      .toContain(channel);

    // Signing out on A (from the chat view: User settings → Account) forgets
    // A's local state but must not wipe the account's synced session.
    await a.page.getByRole('button', { name: 'User settings' }).click();
    const settings = a.page.getByRole('dialog', { name: 'User settings' });
    await settings.getByRole('tab', { name: /^Account/ }).click();
    await settings.getByRole('button', { name: 'Sign out' }).click();
    await expect(a.page.locator('.login-screen')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => a.page.evaluate(() => localStorage.getItem('boson:session:v2'))).toBeNull();
    await a.app.close();
    expect(JSON.stringify((await api.get<{ payload: unknown }>('/me/session')).payload ?? null)).toContain(channel);

    // ---- device B: sign in → same server + channel, reconnected ----
    const joinMark = peer.mark();
    const b = await launchApp({ profile: otherDevice });
    expect(await loginAs(b.page, account)).toBe('directory');
    await expect(b.page.locator('.sidebar-server-name')).toHaveText(seeded.name, { timeout: 45_000 });
    await expect(b.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await peer.waitFor(
      (l) => l.command === 'JOIN' && l.prefix.split('!')[0] === account.handle &&
        (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
      30_000, `${account.handle} joining ${channel} from device B`, joinMark,
    );
    const channels = b.page.getByRole('complementary', { name: 'Channels' });
    await channels.getByText(channel.replace(/^#/, ''), { exact: true }).click();
    const text = `from device B ${uid()}`;
    await sendMessage(b.page, channel, text);
    await peer.waitForPrivmsg(channel, text);
    await expect(composer(b.page, channel)).toBeVisible();
  } finally {
    await peer.quit();
  }
});
