// User Settings (title-bar gear) end to end: profile image upload/replace/
// remove through the backend into MinIO, recovery-code enroll/regenerate,
// local preferences (content embeds, notifications) surviving a relaunch,
// the About panel, sign-out from settings, and the guest-mode sections.
import { deflateSync, crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, STACK,
  backendSql, continueAsGuest, field, loginAs, randomPassword, recoverWithCode, setAuthPassword, signOut, submitLogin, uid,
} from './fixtures';
import { CLIENT_DIR } from './stack';

// ---- helpers ---------------------------------------------------------------

async function openSettings(page: Page, section?: string): Promise<Locator> {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await expect(dialog).toBeVisible();
  if (section) await dialog.getByRole('tab', { name: new RegExp(`^${section}`) }).click();
  return dialog;
}

async function closeSettings(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
}

// A solid-color w×h RGB PNG, built by hand (no image deps in the test).
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const avatarKey = (userId: string): string =>
  backendSql(`SELECT coalesce(avatar_storage_key, '') FROM users WHERE id = '${userId}'`);

// ---- profile image ---------------------------------------------------------

test('profile image: upload, replace and remove land in object storage and the title bar', async ({ launchApp, account, backendApi }) => {
  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  const api = await backendApi(account);

  const dialog = await openSettings(page);
  const file = dialog.locator('input[type="file"]');
  await expect(dialog.getByRole('button', { name: 'Upload' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove' })).toBeHidden();

  // Client-side checks reject non-images before any upload.
  await file.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(dialog.locator('.user-settings-error')).toHaveText('Please choose an image file.');
  // An "image" the backend can't decode → 400 → a readable error.
  await file.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') });
  await expect(dialog.locator('.user-settings-error')).toHaveText('That file isn’t a supported image.');
  expect(avatarKey(account.id)).toBe('');

  // ---- upload ----
  await file.setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: png(32, 32, [220, 30, 30]) });
  await expect(dialog.getByRole('button', { name: 'Change' })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('.user-settings-error')).toBeHidden();
  const first = await api.get<{ avatar_url?: string }>('/me');
  expect(first.avatar_url).toMatch(new RegExp(`^${STACK.minio.endpoint}/${STACK.minio.bucket}/.+\\.png$`));
  const firstKey = avatarKey(account.id);
  expect(first.avatar_url!.endsWith(firstKey)).toBe(true);
  const img = await fetch(first.avatar_url!);
  expect(img.status).toBe(200);
  expect(img.headers.get('content-type')).toBe('image/png');
  await expect(dialog.locator('.user-settings-avatar img')).toHaveAttribute('src', first.avatar_url!);
  // Mirrored into the session metadata → the title bar shows it at once.
  await expect(page.locator('.title-bar-user-avatar img')).toHaveAttribute('src', first.avatar_url!);

  // ---- replace: new object, the old one is deleted ----
  await file.setInputFiles({ name: 'blue.png', mimeType: 'image/png', buffer: png(48, 48, [20, 40, 230]) });
  await expect.poll(() => avatarKey(account.id), { timeout: 20_000 }).not.toBe(firstKey);
  const second = await api.get<{ avatar_url?: string }>('/me');
  await expect(page.locator('.title-bar-user-avatar img')).toHaveAttribute('src', second.avatar_url!);
  expect((await fetch(second.avatar_url!)).status).toBe(200);
  expect((await fetch(first.avatar_url!)).status).not.toBe(200);

  // ---- remove ----
  await dialog.getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.getByRole('button', { name: 'Upload' })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.locator('.user-settings-avatar img')).toHaveCount(0);
  expect(avatarKey(account.id)).toBe('');
  expect((await api.get<{ avatar_url?: string }>('/me')).avatar_url).toBeUndefined();
  expect((await fetch(second.avatar_url!)).status).not.toBe(200);
  await expect(page.locator('.title-bar-user-avatar img')).toHaveCount(0);
  await expect(page.locator('.title-bar-user-avatar')).toHaveText(account.handle!.charAt(0).toUpperCase());
});

// ---- recovery code ---------------------------------------------------------

test('regenerating the recovery code replaces the wrap: the old code stops working, the new one unlocks', async ({ launchApp, account }) => {
  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  const wrap = (): string => backendSql(`SELECT encode(encrypted_user_secret_recovery, 'base64') FROM users WHERE id = '${account.id}'`);
  const wrapBefore = wrap();

  const dialog = await openSettings(page, 'Account');
  await expect(dialog.locator('.user-settings-row').filter({ hasText: 'Email' })).toContainText(account.email);
  await expect(dialog.locator('.user-settings-recovery')).toContainText('Enabled');
  await dialog.getByRole('button', { name: 'Regenerate recovery code' }).click();

  const code = dialog.getByLabel('recovery code', { exact: true });
  await expect(code).toBeVisible({ timeout: 20_000 });
  const newCode = (await code.innerText()).trim();
  expect(newCode).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){7}$/);
  expect(newCode).not.toBe(account.recoveryCode);
  const done = dialog.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();
  await dialog.getByText('I’ve saved my recovery code somewhere safe.').click();
  await done.click();
  await expect(dialog.locator('.user-settings-recovery')).toContainText('Enabled');
  expect(wrap()).not.toBe(wrapBefore);
  await closeSettings(dialog);

  // After a password reset only the NEW code opens the identity.
  await signOut(page);
  const newPassword = randomPassword();
  await setAuthPassword(account.id, newPassword);
  await submitLogin(page, { email: account.email, password: newPassword });
  await expect(page.locator('.login-error')).toContainText('enter your recovery code');
  await page.getByPlaceholder('xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx').fill(account.recoveryCode!);
  await page.getByRole('button', { name: 'Recover with code' }).click();
  await expect(page.locator('.login-error')).toContainText('Recovery code rejected');
  await page.getByPlaceholder('xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx').fill('');
  await recoverWithCode(page, newCode);
  await expect(page.locator('.directory-handle')).toHaveText(`@${account.handle}`);
});

test('an account without a recovery code can set one up from settings', async ({ launchApp, account, backendApi }) => {
  backendSql(`UPDATE users SET encrypted_user_secret_recovery = NULL WHERE id = '${account.id}'`);
  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');

  const dialog = await openSettings(page, 'Account');
  await expect(dialog.locator('.user-settings-recovery')).toContainText('Not set up');
  await dialog.getByRole('button', { name: 'Set up recovery code' }).click();
  const code = (await dialog.getByLabel('recovery code', { exact: true }).innerText()).trim();
  expect(code).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){7}$/);
  await dialog.getByText('I’ve saved my recovery code somewhere safe.').click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog.locator('.user-settings-recovery')).toContainText('Enabled');
  const me = await (await backendApi(account)).get<{ encrypted_user_secret_recovery?: string }>('/me');
  expect(me.encrypted_user_secret_recovery?.length ?? 0).toBeGreaterThan(40);
});

// ---- sign out from settings ------------------------------------------------

test('signing out from settings clears this device like the directory sign-out does', async ({ launchApp, account }) => {
  const first = await launchApp();
  const { page } = first;
  expect(await loginAs(page, account)).toBe('directory');
  const keychain = (): Promise<string | null> => page.evaluate(
    (key) => (window as unknown as { bosonSecure: { get(k: string): Promise<string | null> } }).bosonSecure.get(key),
    `boson.identity.${account.id}`,
  );
  await expect.poll(keychain).not.toBeNull();

  const dialog = await openSettings(page, 'Account');
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.login-screen')).toBeVisible({ timeout: 20_000 });
  // The persisted identity secret must not outlive the sign-out.
  await expect.poll(keychain).toBeNull();

  // A relaunch stays signed out, and signing back in works.
  await first.app.close();
  const second = await launchApp();
  await expect(second.page.locator('.login-screen')).toBeVisible({ timeout: 30_000 });
  expect(await loginAs(second.page, account)).toBe('directory');
});

// ---- local preferences -----------------------------------------------------

test('content and notification preferences persist across a relaunch', async ({ launchApp, account }) => {
  const first = await launchApp();
  expect(await loginAs(first.page, account)).toBe('directory');
  let dialog = await openSettings(first.page, 'Content');
  const box = (d: Locator, label: string) => d.getByRole('checkbox', { name: label, exact: true });
  const flip = async (d: Locator, label: string) => { await d.getByText(label, { exact: true }).click(); };

  // Defaults: on + auto-load.
  await expect(box(dialog, 'Show link embeds')).toBeChecked();
  await expect(box(dialog, 'Auto-load previews (turn off to load on click — more private)')).toBeChecked();
  await flip(dialog, 'Auto-load previews (turn off to load on click — more private)');
  await flip(dialog, 'YouTube');
  await expect(box(dialog, 'YouTube')).not.toBeChecked();
  // The master switch disables the per-type toggles.
  await flip(dialog, 'Show link embeds');
  await expect(box(dialog, 'Images')).toBeDisabled();
  await flip(dialog, 'Show link embeds');
  await expect(box(dialog, 'Images')).toBeEnabled();

  await dialog.getByRole('tab', { name: /^Notifications/ }).click();
  await expect(box(dialog, 'Enable desktop notifications')).toBeChecked();
  await flip(dialog, 'Every channel message (noisy)');
  await flip(dialog, 'Play notification sound');
  const soundBefore = await box(dialog, 'Play notification sound').isChecked();
  const allBefore = await box(dialog, 'Every channel message (noisy)').isChecked();
  await flip(dialog, 'Enable desktop notifications');
  await expect(box(dialog, 'Direct messages')).toBeDisabled();

  const stored = await first.page.evaluate(() => ({
    embeds: JSON.parse(localStorage.getItem('boson:embeds:v1') ?? 'null'),
    notifications: JSON.parse(localStorage.getItem('boson:notifications:v1') ?? 'null'),
  }));
  expect(stored.embeds).toMatchObject({ enabled: true, loadMode: 'click', youtube: false, images: true });
  expect(stored.notifications).toMatchObject({ enabled: false, allMessages: allBefore, sound: soundBefore });
  await first.app.close();

  // Relaunch (signed-in session restores) → the same values are shown.
  const second = await launchApp();
  await expect(second.page.getByRole('heading', { name: 'Server Directory' })).toBeVisible({ timeout: 45_000 });
  dialog = await openSettings(second.page, 'Content');
  await expect(box(dialog, 'Auto-load previews (turn off to load on click — more private)')).not.toBeChecked();
  await expect(box(dialog, 'YouTube')).not.toBeChecked();
  await expect(box(dialog, 'Spotify')).toBeChecked();
  await dialog.getByRole('tab', { name: /^Notifications/ }).click();
  await expect(box(dialog, 'Enable desktop notifications')).not.toBeChecked();
  await expect(box(dialog, 'Play notification sound')).toBeChecked({ checked: soundBefore });
  await expect(box(dialog, 'Every channel message (noisy)')).toBeChecked({ checked: allBefore });
});

test('appearance and about: theme picker, version, update check and the source link', async ({ launchApp }) => {
  const { page, openedExternally } = await launchApp();
  await continueAsGuest(page, `abt${uid()}`);
  const dialog = await openSettings(page, 'Appearance');
  await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  // The theme picker (themes.spec.ts covers switching and custom themes).
  await expect(dialog.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /^Terminal/ })).toHaveAttribute('aria-checked', 'true');

  await dialog.getByRole('tab', { name: /^About/ }).click();
  const version = (JSON.parse(readFileSync(join(CLIENT_DIR, 'package.json'), 'utf8')) as { version: string }).version;
  await expect(dialog.locator('.user-settings-row').filter({ hasText: 'Version' })).toContainText(`v${version}`);
  await expect(dialog.locator('.user-settings-row').filter({ hasText: 'Platform' })).toContainText(process.platform);
  // Unpackaged builds have no updater feed: a manual check reports up to date.
  await dialog.getByRole('button', { name: 'Check for updates' }).click();
  await expect(dialog.getByText('Up to date.')).toBeVisible();

  await dialog.getByRole('link', { name: 'github.com/boson-chat/boson' }).click();
  await expect.poll(openedExternally).toContain('https://github.com/boson-chat/boson');
  await dialog.getByRole('link', { name: `v${version} on GitHub →` }).click();
  await expect.poll(openedExternally).toContain(`https://github.com/boson-chat/boson/releases/tag/v${version}`);
});

// ---- guest mode ------------------------------------------------------------

test('guest settings: rename the nick, bouncer form validation, and switch to an account', async ({ launchApp }) => {
  const { page } = await launchApp();
  const nick = `gst${uid()}`;
  await continueAsGuest(page, nick);
  await expect(page.locator('.title-bar-user-name')).toHaveText(nick);
  await expect(page.locator('.title-bar-user-tag')).toHaveText('guest');

  const dialog = await openSettings(page);
  await expect(dialog.locator('.user-settings-row').filter({ hasText: 'Mode' })).toContainText('Guest');
  const nickInput = field(dialog, 'Nick');
  await expect(nickInput).toHaveValue(nick);
  // Sanitised like IRC wants it: spaces/@/. are not allowed in a nick.
  const renamed = `ren${uid()}`;
  await nickInput.fill(`${renamed} @x`);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
  await expect(page.locator('.title-bar-user-name')).toHaveText(new RegExp(`^${renamed}`));
  const saved = await page.evaluate(() => Object.entries(localStorage).find(([k]) => /guest/i.test(k))?.[1] ?? '');
  expect(saved).toContain(renamed);
  expect(saved).not.toContain(' ');
  expect(saved).not.toContain('@');

  // Bouncer: enabling it requires host + username before Save is allowed.
  await dialog.getByRole('tab', { name: /^Bouncer/ }).click();
  await expect(dialog.getByText('Sign in to sync this bouncer across your devices.', { exact: false })).toBeVisible();
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await dialog.getByText('Use a bouncer', { exact: true }).click();
  await expect(save).toBeDisabled();
  await field(dialog, 'Host').fill('znc.example.test');
  await expect(save).toBeDisabled();
  await field(dialog, 'Username').fill('me');
  await expect(save).toBeEnabled();
  await dialog.getByText('Allow self-signed certificate', { exact: true }).click();
  await expect(dialog.getByText('Skips TLS certificate verification', { exact: false })).toBeVisible();
  await save.click();
  await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(field(dialog, 'Host')).toHaveValue('');
  await expect(dialog.getByRole('checkbox', { name: 'Use a bouncer', exact: true })).not.toBeChecked();

  // Account → "Switch to an account" leaves guest mode for the login screen.
  await dialog.getByRole('tab', { name: /^Account/ }).click();
  await dialog.getByRole('button', { name: 'Switch to an account' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.login-screen')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Login' })).toBeVisible();
});
