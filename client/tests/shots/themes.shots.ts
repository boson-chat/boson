// Screenshots for the website's Themes docs.
import { test, expect, type Page } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../website/public/screenshots');
const shot = (page: Page, name: string) => page.screenshot({ path: resolve(OUT, name) });
// Settings shots are cropped to the dialog (plus a margin) so it fills the frame.
async function dialogShot(page: Page, name: string): Promise<void> {
  const box = (await page.getByRole('dialog', { name: 'User settings' }).boundingBox())!;
  const m = 24;
  await page.screenshot({
    path: resolve(OUT, name),
    clip: { x: box.x - m, y: box.y - m, width: box.width + 2 * m, height: box.height + 2 * m },
  });
}

// Theme choice lives in local storage; set it before the page loads.
async function withTheme(page: Page, id: string): Promise<void> {
  await page.addInitScript((active) => {
    localStorage.setItem('boson:theme:v1', JSON.stringify({ active }));
  }, id);
}

async function openAppearance(page: Page): Promise<void> {
  await page.goto('/shots.html?view=settings');
  await page.getByRole('tab', { name: /^Appearance/ }).click();
  await expect(page.getByRole('radio', { name: /^Terminal/ })).toBeVisible();
}

test('appearance: the theme gallery', async ({ page }) => {
  await withTheme(page, 'nord');
  await openAppearance(page);
  await expect(page.getByRole('radio', { name: /^Nord/ })).toHaveAttribute('aria-checked', 'true');
  await dialogShot(page, 'theme-gallery.png');
});

test('appearance: the editor with the colour picker open', async ({ page }) => {
  await openAppearance(page);
  await page.getByRole('button', { name: 'Customize Terminal' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Ember');
  const swatch = page.getByRole('button', { name: 'Accent colour picker', exact: true });
  // Accent near the top of the scroll area, so the picker opens below it in full.
  await swatch.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await swatch.click();
  const pick = page.getByRole('dialog', { name: 'Pick Accent' });
  await pick.getByRole('textbox', { name: 'Hex' }).fill('#e8590c');
  await expect(page.getByRole('textbox', { name: 'Accent', exact: true })).toHaveValue('#e8590c');
  await page.mouse.move(0, 0); // no hover states in the shot
  await dialogShot(page, 'theme-editor.png');
  // The full window, like the other Features page shots.
  await shot(page, 'feat-appearance.png');
});

for (const [id, file] of [['daylight', 'theme-chat-daylight.png']] as const) {
  test(`chat in ${id}`, async ({ page }) => {
    await withTheme(page, id);
    await page.goto('/shots.html?view=chat');
    await expect(page.getByText('YOU JOINED #DEV', { exact: false }).or(page.getByText('You joined #dev'))).toBeVisible();
    await page.waitForTimeout(500); // embeds / avatars settle
    await shot(page, file);
  });
}
