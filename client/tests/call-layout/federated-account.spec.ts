import { test, expect, type Page } from '@playwright/test';

// Signed in to a self-hosted network with a boson.chat account (federated):
// the title bar shows the name with a dim "@boson.chat" and no guest tag,
// and Settings → Account & security says who signs you in, with Sign out.

const SHOTS = process.env['SHOTS_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('title bar after a federated home sign-in', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=chat&frame=1&fed=1');
  const chip = page.locator('.title-bar-user');
  await expect(chip).toContainText('alice-bosonchat');
  await expect(chip.locator('.title-bar-user-home')).toHaveText('@boson.chat');
  await expect(chip.locator('.title-bar-user-tag')).toHaveCount(0);
  await shot(page, 'federated-titlebar');
  if (SHOTS) await chip.screenshot({ path: `${SHOTS}/federated-titlebar-chip.png` });
});

test('Settings → Account & security after a federated home sign-in', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=settings&fed=1&section=account');
  const row = page.locator('.user-settings-federated');
  await expect(row).toContainText('alice@boson.chat');
  await expect(row).toContainText('boson.chat vouches for you');
  await expect(page.locator('.user-settings-email')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await shot(page, 'federated-settings-account');
});

test('Settings on a phone after a federated home sign-in', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 780 });
  await page.goto('/shots.html?view=settings&fed=1');
  await expect(page.getByRole('button', { name: /Your profile/ })).toContainText('alice@boson.chat');
  await shot(page, 'federated-settings-phone');
});
