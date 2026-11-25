import { test, expect, type Locator, type Page } from '@playwright/test';

// User settings and Server settings on a narrow phone (360px): Server
// settings' section strip leaves room past its last tab, nothing pushes the
// body wider than the screen, and Advanced's command rows stack rather than
// squeeze. (User settings is a drill-down list on phones.)

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

// Scrolled to its end, the strip's last tab stops short of the strip's edge.
async function lastTabInset(strip: Locator): Promise<number> {
  return strip.evaluate((nav) => {
    nav.scrollLeft = nav.scrollWidth;
    const tabs = nav.querySelectorAll<HTMLElement>('[role="tab"]');
    const last = tabs[tabs.length - 1]!.closest<HTMLElement>('.bds-row') ?? tabs[tabs.length - 1]!;
    return nav.getBoundingClientRect().right - last.getBoundingClientRect().right;
  });
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
});

test('server settings at 360px: no sideways scroll, strip end inset, Advanced rows stack', async ({ page }) => {
  await page.goto('/shots.html?view=services');
  const strip = page.locator('.server-settings-menu');
  const tabs = strip.getByRole('tab');
  const n = await tabs.count();
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).click();
    await noSideways(page, '.server-settings-body');
  }
  expect(await lastTabInset(strip)).toBeGreaterThanOrEqual(7); // 8px, less sub-pixel scroll rounding

  await strip.getByRole('tab', { name: /^Advanced/ }).click();
  // The services sub-tabs keep a gap between them and scroll within their strip.
  const sub = page.locator('.server-settings-advanced .bds-tabs');
  const boxes = await sub.getByRole('tab').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.left - boxes[i - 1]!.right).toBeGreaterThanOrEqual(8);
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
  // No double indent: the NickServ card lines up with the search box.
  const search = (await page.locator('.server-settings-advanced-search input').boundingBox())!;
  expect(Math.abs(hint.x - search.x)).toBeLessThanOrEqual(1);
});

test('user settings at 360px: no sideways scroll in the list or any section', async ({ page }) => {
  // Phones drill down (a list of sections, then one full screen) rather
  // than a strip of tabs.
  await page.goto('/shots.html?view=settings&platform=ios&friends=1&images=1&voice=connected');
  const dialog = page.getByRole('dialog');
  const list = dialog.locator('.user-settings-phone-list');
  await expect(list).toBeVisible();
  await noSideways(page, '.user-settings-phone-list');
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
