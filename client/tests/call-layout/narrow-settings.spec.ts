import { test, expect, type Page } from '@playwright/test';

// User settings and Server settings on a narrow phone (360px): both are a
// drill-down list of their sections; nothing pushes the list or a section
// wider than the screen, and Advanced's command rows stack rather than
// squeeze.

async function noSideways(page: Page, body: string): Promise<void> {
  const { body: b, doc } = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const d = document.scrollingElement!;
    return {
      body: { sw: el.scrollWidth, cw: el.clientWidth },
      doc: { sw: d.scrollWidth, cw: d.clientWidth },
    };
  }, body);
  expect(b.sw, `${body} scrolls sideways`).toBeLessThanOrEqual(b.cw);
  expect(doc.sw, 'page scrolls sideways').toBeLessThanOrEqual(doc.cw);
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
});

test('server settings at 360px: no sideways scroll in the list or any section, Advanced rows stack', async ({ page }) => {
  await page.goto('/shots.html?view=services&owner=1&nettheme=1');
  const dialog = page.getByRole('dialog');
  const list = dialog.locator('.settings-phone-list');
  await expect(list).toBeVisible();
  await noSideways(page, '.settings-phone-list');
  const rows = list.locator('nav').getByRole('button');
  const n = await rows.count();
  expect(n).toBe(11);
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click();
    await expect(dialog.getByRole('button', { name: 'Back to settings' })).toBeVisible();
    await noSideways(page, '.server-settings-body');
    await dialog.getByRole('button', { name: 'Back to settings' }).click();
  }

  // Advanced: its command groups are a list too; each opens on its own.
  await list.locator('nav').getByRole('button', { name: /^Advanced/ }).click();
  const groups = dialog.getByRole('navigation', { name: 'Command groups' });
  await noSideways(page, '.server-settings-body');
  await groups.getByRole('button', { name: /^NickServ/ }).click();
  await expect(dialog.locator('.bds-page-title')).toHaveText('NickServ');
  await noSideways(page, '.server-settings-body');

  // IDENTIFY: the description runs full width; the input sits below it.
  const row = page.locator('.server-settings-cmd-row').filter({ hasText: 'IDENTIFY' }).first();
  const hint = (await row.locator('.server-settings-cmd-hint').boundingBox())!;
  const input = (await row.locator('input').boundingBox())!;
  const button = (await row.getByRole('button').boundingBox())!;
  expect(overlaps(hint, input)).toBe(false);
  expect(overlaps(hint, button)).toBe(false);
  expect(input.y).toBeGreaterThanOrEqual(hint.y + hint.height);
  expect(hint.width).toBeGreaterThan(200);
  // No double indent: the NickServ card lines up with the page's text.
  const body = (await page.locator('.server-settings-body').boundingBox())!;
  expect(Math.abs(hint.x - (body.x + 16))).toBeLessThanOrEqual(1);
});

test('user settings at 360px: no sideways scroll in the list or any section', async ({ page }) => {
  // Phones drill down (a list of sections, then one full screen) rather
  // than a strip of tabs.
  await page.goto('/shots.html?view=settings&platform=ios&friends=1&images=1&voice=connected');
  const dialog = page.getByRole('dialog');
  const list = dialog.locator('.settings-phone-list');
  await expect(list).toBeVisible();
  await noSideways(page, '.settings-phone-list');
  const rows = list.locator('nav').getByRole('button');
  const n = await rows.count();
  expect(n).toBeGreaterThan(5);
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click();
    await expect(dialog.locator('.bds-page-head')).toBeVisible();
    await noSideways(page, '.user-settings-phone-body');
    await dialog.getByRole('button', { name: 'Back to settings' }).click();
  }
});
