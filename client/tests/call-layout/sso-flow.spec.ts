import { test, expect, type Page } from '@playwright/test';

// "Continue with IRCForever" (an identity provider, SSO) on a self-hosted
// web client (the whole app, shots.html?view=ssoflow): straight into the
// app, no "Unlock your identity key" step, for an existing account whose
// key a Boson password wraps and for one the sign-in just made. The key is
// asked for only when something needs it.

const SHOTS = process.env['SHOTS_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const [label, size] of [['desktop', { width: 1280, height: 820 }], ['phone', { width: 375, height: 780 }]] as const) {
  test(`an SSO sign-in goes straight into the app at ${label} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/shots.html?view=ssoflow');
    const cont = page.getByRole('button', { name: 'Continue with IRCForever' });
    await expect(cont).toBeVisible();
    await shot(page, `ssoflow-${label}-1-signin`);
    await cont.click();

    await expect(page.getByPlaceholder('Search servers…')).toBeVisible();
    await expect(page.getByText('Unlock your identity key')).toHaveCount(0);
    await expect(page.getByText(/protected by your Boson password/)).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await shot(page, `ssoflow-${label}-2-app`);

    // Later, something needs the key: asked for then, saying why.
    void page.evaluate(() => (window as { __askKey?: (r: string) => Promise<boolean> }).__askKey!('nickserv'));
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Password or passphrase')).toBeVisible();
    await expect(dialog).toContainText('You signed in with IRCForever');
    const fits = await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
    await shot(page, `ssoflow-${label}-3-key-prompt`);
    await dialog.getByLabel('Password or passphrase').fill('admin password');
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('a new SSO account picks only its handle, then is in', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=ssoflow&new=1');
  await page.getByRole('button', { name: 'Continue with IRCForever' }).click();
  const handle = page.getByPlaceholder('handle');
  await expect(handle).toBeVisible();
  await expect(page.getByPlaceholder('password')).toHaveCount(0);
  await expect(page.getByLabel('Passphrase')).toHaveCount(0);
  await shot(page, 'ssoflow-desktop-4-new-handle');
  await handle.fill('admin');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByPlaceholder('Search servers…')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
