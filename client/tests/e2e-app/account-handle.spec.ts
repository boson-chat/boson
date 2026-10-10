// The Boson handle: first-sign-in setup validation (POST /me) and renaming
// it later from User settings → Identity (PATCH /me), including taken and
// invalid handles, with the result checked in the backend (users +
// handle_changes, whose redirect window is 90 days).
import type { Page } from '@playwright/test';
import { test, expect, backendSql, field, loginAs, randomHandle } from './fixtures';

async function openIdentitySettings(page: Page) {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: /^Identity/ }).click();
  return dialog;
}

test('first sign-in handle setup rejects short and taken handles, then accepts a free one', async ({ launchApp, createAccount, account: other, backendApi }) => {
  const fresh = await createAccount();
  const { page } = await launchApp();
  expect(await loginAs(page, fresh)).toBe('setup');

  const input = page.getByPlaceholder('handle', { exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const setupError = page.locator('.directory-setup-prompt .bds-field');

  await input.fill('ab');
  await expect(save).toBeDisabled();

  // Padded to 3+ chars client-side, but the backend trims → 400.
  await input.fill('  ab  ');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(setupError).toContainText('handle must be at least 3 characters');

  // Taken — case-insensitively.
  await input.fill(other.handle!.toUpperCase());
  await save.click();
  await expect(setupError).toContainText('handle taken');
  expect(backendSql(`SELECT count(*) FROM users WHERE id = '${fresh.id}'`)).toBe('0');

  // The pending identity survives the failed attempts: a free handle works.
  const handle = randomHandle('setup');
  await input.fill(handle);
  await save.click();
  await expect(page.getByLabel('recovery code', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByText('I’ve saved my recovery code somewhere safe.').click();
  await page.locator('.recovery-code-reveal').getByRole('button').last().click();
  await expect(page.locator('.directory-handle')).toHaveText(`@${handle}`);
  const me = await (await backendApi(fresh)).get<{ handle: string; encrypted_user_secret_recovery: string }>('/me');
  expect(me.handle).toBe(handle);
  expect(me.encrypted_user_secret_recovery.length).toBeGreaterThan(40);
});

test('renaming the handle in settings: taken and too-short are refused, a free one is saved with a 90-day redirect', async ({ launchApp, createAccount, backendApi }) => {
  const me = await createAccount({ handle: true });
  const other = await createAccount({ handle: true });
  const first = await launchApp();
  const { page } = first;
  expect(await loginAs(page, me)).toBe('directory');

  const dialog = await openIdentitySettings(page);
  await expect(dialog.locator('.user-settings-row').filter({ hasText: 'Mode' })).toContainText('Account');
  const input = field(dialog, 'Handle');
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  const error = dialog.locator('.user-settings-error');
  await expect(input).toHaveValue(me.handle!);
  await expect(save).toBeDisabled(); // unchanged

  await input.fill(other.handle!);
  await save.click();
  await expect(error).toHaveText('That handle is taken — pick another.');

  await input.fill('  x  ');
  await save.click();
  await expect(error).toHaveText('Handle must be at least 3 characters.');
  expect(backendSql(`SELECT handle FROM users WHERE id = '${me.id}'`)).toBe(me.handle);

  const renamed = randomHandle('ren');
  await input.fill(renamed);
  await save.click();
  await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
  await expect(error).toBeHidden();
  await expect(save).toBeDisabled();

  // Backend: the row is renamed and the change audited with a 90-day redirect.
  const api = await backendApi(me);
  expect((await api.get<{ handle: string; handle_changed_at: string }>('/me')).handle).toBe(renamed);
  const audit = backendSql(
    `SELECT old_handle || '|' || new_handle || '|' || round(extract(epoch FROM redirect_until - changed_at) / 86400)
       FROM handle_changes WHERE user_id = '${me.id}'`,
  );
  expect(audit).toBe(`${me.handle}|${renamed}|90`);

  // The session metadata mirrors it, so the title bar follows immediately.
  await expect(page.locator('.title-bar-user-name')).toHaveText(renamed);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Re-opening reads the authoritative value from /me.
  const again = await openIdentitySettings(page);
  await expect(field(again, 'Handle')).toHaveValue(renamed);
  await again.getByRole('button', { name: 'Close' }).click();

  // And the next launch signs in as the new handle.
  await first.app.close();
  const second = await launchApp();
  await expect(second.page.locator('.directory-handle')).toHaveText(`@${renamed}`, { timeout: 45_000 });
  await expect(second.page.locator('.title-bar-user-name')).toHaveText(renamed);
});
