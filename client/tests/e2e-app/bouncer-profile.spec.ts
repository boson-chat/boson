// User settings → Bouncer: the global ZNC/BNC profile. Validation and
// toggles, persistence in the OS-keychain-backed secure store (and only
// encrypted on disk), and — for a signed-in user — end-to-end-encrypted sync
// through the backend's /me/bouncer to another device of the same account
// (last writer wins; Clear removes the server copy).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, uid, field, continueAsGuest, configureBouncerProfile, loginAs, type Profile,
} from './fixtures';

async function openBouncerSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: /^Bouncer/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Bouncer (ZNC / BNC)' })).toBeVisible();
  return dialog;
}

async function closeSettings(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
}

async function toggle(dialog: Locator, label: string, want: boolean): Promise<void> {
  const box = dialog.getByRole('checkbox', { name: label, exact: true });
  if ((await box.isChecked()) !== want) await dialog.getByText(label, { exact: true }).click();
  await expect(box).toBeChecked({ checked: want });
}

// A second app profile (another "device") with its own cleanup.
function makeProfile(): Profile {
  const root = mkdtempSync(join('/tmp', 'boson-e2e-'));
  const p = { root, home: join(root, 'home'), runtime: join(root, 'run'), userData: join(root, 'userData') };
  for (const d of [p.home, p.runtime, p.userData]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return p;
}

interface BouncerDTO { ciphertext: string; updated_at: string }

// Secure-store tag on disk: the e2e build runs the store in its derived-key
// mode (BOSON_SECURE_STORE=derived), whose values are "fb1:" ciphertext,
// never plain text.
const STORE_TAG = /^fb1:/;

test.describe('bouncer profile', () => {
  test('validation, toggles, Clear, and persistence across a relaunch (encrypted at rest)', async ({ launchApp, profile }) => {
    const host = `znc-${uid()}.example.test`;
    const user = `user${uid()}`;
    const password = `pw-${uid(10)}`;
    const first = await launchApp();
    let page = first.page;
    await continueAsGuest(page, `bp${uid()}`);

    let dialog = await openBouncerSettings(page);
    // Defaults: off, TLS on, verification on, the standard TLS port.
    await expect(dialog.getByRole('checkbox', { name: 'Use a bouncer', exact: true })).not.toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Use TLS', exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Allow self-signed certificate', exact: true })).not.toBeChecked();
    await expect(field(dialog, 'Port')).toHaveValue('6697');
    await expect(dialog.getByText("Sign in to sync this bouncer across your devices.")).toBeVisible();

    // Enabling needs a host AND a username before Save is allowed.
    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeEnabled();
    await toggle(dialog, 'Use a bouncer', true);
    await expect(save).toBeDisabled();
    await field(dialog, 'Host').fill(`  ${host}  `);
    await expect(save).toBeDisabled();
    await field(dialog, 'Username').fill('   ');
    await expect(save).toBeDisabled();
    await field(dialog, 'Username').fill(` ${user} `);
    await expect(save).toBeEnabled();

    // "Allow self-signed" warns about what it gives up.
    const warning = dialog.getByText('Skips TLS certificate verification');
    await expect(warning).toHaveCount(0);
    await toggle(dialog, 'Allow self-signed certificate', true);
    await expect(warning).toBeVisible();
    await toggle(dialog, 'Allow self-signed certificate', false);
    await expect(warning).toHaveCount(0);
    await toggle(dialog, 'Allow self-signed certificate', true);

    await field(dialog, 'Port').fill('7000');
    await field(dialog, 'Password').fill(password);
    await save.click();
    await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
    await closeSettings(dialog);

    // The directory's Bouncer tab picks it up (host trimmed).
    await page.getByRole('tab', { name: 'Bouncer' }).click();
    await expect(page.getByText(`${host}:7000`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pull from bouncer' })).toBeVisible();

    // On disk it's only ciphertext (secure store → OS keychain encryption).
    await expect.poll(() => {
      try { return readFileSync(join(profile.userData, 'identity-store.json'), 'utf8'); } catch { return ''; }
    }).toContain('boson.bouncer.v1');
    const onDisk = readFileSync(join(profile.userData, 'identity-store.json'), 'utf8');
    expect(onDisk).not.toContain(password);
    expect(onDisk).not.toContain(host);
    expect(JSON.parse(onDisk)['boson.bouncer.v1']).toMatch(STORE_TAG);

    // Relaunch: still there, trimmed values and toggles intact.
    await first.app.close();
    page = (await launchApp()).page;
    await expect(page.getByRole('heading', { name: 'Server Directory' })).toBeVisible({ timeout: 30_000 });
    dialog = await openBouncerSettings(page);
    await expect(dialog.getByRole('checkbox', { name: 'Use a bouncer', exact: true })).toBeChecked();
    await expect(field(dialog, 'Host')).toHaveValue(host);
    await expect(field(dialog, 'Port')).toHaveValue('7000');
    await expect(field(dialog, 'Username')).toHaveValue(user);
    await expect(field(dialog, 'Password')).toHaveValue(password);
    await expect(dialog.getByRole('checkbox', { name: 'Allow self-signed certificate', exact: true })).toBeChecked();
    await expect(dialog.getByText('Skips TLS certificate verification')).toBeVisible();

    // Clear wipes the form and the stored profile.
    await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
    await expect(field(dialog, 'Host')).toHaveValue('');
    await expect(dialog.getByRole('checkbox', { name: 'Use a bouncer', exact: true })).not.toBeChecked();
    await closeSettings(dialog);
    await page.getByRole('tab', { name: 'Bouncer' }).click();
    await expect(page.getByText('No bouncer enabled')).toBeVisible();
    await expect.poll(() => readFileSync(join(profile.userData, 'identity-store.json'), 'utf8')).not.toContain('boson.bouncer.v1');
  });

  test('signed in: the profile syncs E2E-encrypted to another device; last writer wins; Clear removes it', async ({ launchApp, account, backendApi, zncUser }) => {
    const api = await backendApi(account);
    const other = makeProfile();
    let b: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      // ---- device A: sign in, configure ----
      const a = await launchApp();
      expect(await loginAs(a.page, account)).toBe('directory');
      let dialog = await openBouncerSettings(a.page);
      await expect(dialog.getByText('Sign in to sync this bouncer')).toHaveCount(0); // account mode
      await closeSettings(dialog);
      await configureBouncerProfile(a.page, {
        host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
      });

      // Pushed (debounced) to /me/bouncer — as ciphertext only.
      await expect.poll(async () => (await api.get<{ bouncer: BouncerDTO | null }>('/me/bouncer')).bouncer, {
        timeout: 15_000,
      }).not.toBeNull();
      const first = (await api.get<{ bouncer: BouncerDTO }>('/me/bouncer')).bouncer;
      const blob = Buffer.from(first.ciphertext, 'base64').toString('latin1');
      expect(blob).not.toContain(zncUser.username);
      expect(blob).not.toContain(zncUser.host);
      expect(first.ciphertext.length).toBeGreaterThan(40);

      // ---- device B: signing in pulls + decrypts it ----
      b = await launchApp({ profile: other });
      expect(await loginAs(b.page, account)).toBe('directory');
      await b.page.getByRole('tab', { name: 'Bouncer' }).click();
      await expect(b.page.getByText(`${zncUser.host}:${zncUser.port}`)).toBeVisible({ timeout: 15_000 });
      dialog = await openBouncerSettings(b.page);
      await expect(dialog.getByRole('checkbox', { name: 'Use a bouncer', exact: true })).toBeChecked();
      await expect(field(dialog, 'Host')).toHaveValue(zncUser.host);
      await expect(field(dialog, 'Port')).toHaveValue(String(zncUser.port));
      await expect(field(dialog, 'Username')).toHaveValue(zncUser.username);
      await expect(field(dialog, 'Password')).toHaveValue(zncUser.password);
      await expect(dialog.getByRole('checkbox', { name: 'Use TLS', exact: true })).not.toBeChecked();

      // The synced profile is usable on B: discovery reaches the real ZNC.
      await closeSettings(dialog);
      await b.page.getByRole('button', { name: 'Pull from bouncer' }).click();
      await expect(b.page.getByText('Found on your bouncer:', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(b.page.locator('.directory-bouncer-discovered .directory-bouncer-row').filter({ hasText: zncUser.network })).toBeVisible();

      // ---- B edits it → A picks the newer copy up on its next unlock ----
      const renamed = `${zncUser.username}-renamed`;
      dialog = await openBouncerSettings(b.page);
      await field(dialog, 'Username').fill(renamed);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
      await expect.poll(async () => (await api.get<{ bouncer: BouncerDTO }>('/me/bouncer')).bouncer.updated_at, {
        timeout: 15_000,
      }).not.toBe(first.updated_at);
      await closeSettings(dialog);

      await a.app.close();
      const a2 = await launchApp();
      // Relaunch restores the signed-in session from the keychain — no login.
      await expect(a2.page.getByRole('heading', { name: 'Server Directory' })).toBeVisible({ timeout: 30_000 });
      dialog = await openBouncerSettings(a2.page);
      await expect(field(dialog, 'Username')).toHaveValue(renamed, { timeout: 15_000 });

      // ---- Clear on A removes the server-side copy ----
      await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect.poll(async () => (await api.get<{ bouncer: BouncerDTO | null }>('/me/bouncer')).bouncer, {
        timeout: 15_000,
      }).toBeNull();
      await closeSettings(dialog);
    } finally {
      await b?.app.close().catch(() => {});
      rmSync(other.root, { recursive: true, force: true });
    }
  });
});
