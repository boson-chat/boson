import { test, expect, type Page } from '@playwright/test';

// "Continue as ada@boson.chat" on a self-hosted web client (the whole app,
// shots.html?view=fedflow): straight into the app, no identity key step,
// the profile from boson.chat. The key is asked for only when something
// needs it, saying why, and unlocks with the boson.chat passphrase.

const SHOTS = process.env['SHOTS_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  // Let a dialog's entrance transition finish.
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const [label, size] of [['desktop', { width: 1280, height: 820 }], ['phone', { width: 375, height: 780 }]] as const) {
  test(`federated sign-in goes straight into the app at ${label} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/shots.html?view=fedflow');
    const cont = page.getByRole('button', { name: 'Continue as ada@boson.chat' });
    await expect(cont).toBeVisible();
    await shot(page, `fedflow-${label}-1-signin`);
    await cont.click();

    await expect(page.getByPlaceholder('Search servers…')).toBeVisible();
    await expect(page.getByText('Set an identity passphrase.')).toHaveCount(0);
    await expect(page.getByText('Unlock your identity key.')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (label === 'desktop') {
      // The profile is boson.chat's (its handle, with the @boson.chat hint).
      const chip = page.locator('.title-bar-user');
      await expect(chip).toContainText('ada');
      await expect(chip.locator('.title-bar-user-home')).toHaveText('@boson.chat');
    }
    await shot(page, `fedflow-${label}-2-app`);

    // Later, something needs the key: asked for then, saying why.
    void page.evaluate(() => (window as { __askKey?: (r: string) => Promise<boolean> }).__askKey!('nickserv'));
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Password or passphrase')).toBeVisible();
    await expect(dialog).toContainText('NickServ password');
    await expect(dialog).toContainText('ada@boson.chat');
    const fits = await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
    await shot(page, `fedflow-${label}-3-key-prompt`);

    await dialog.getByLabel('Password or passphrase').fill('correct horse battery');
    await dialog.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await shot(page, `fedflow-${label}-4-unlocked`);
  });
}

test('a home account with no key yet: set one up when needed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=fedflow&nokey=1');
  await page.getByRole('button', { name: 'Continue as ada@boson.chat' }).click();
  await expect(page.getByPlaceholder('Search servers…')).toBeVisible();
  void page.evaluate(() => (window as { __askKey?: (r: string) => Promise<boolean> }).__askKey!('bouncer'));
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Confirm passphrase')).toBeVisible();
  await expect(dialog).toContainText("doesn't have one yet");
  await shot(page, 'fedflow-desktop-5-key-setup');
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
