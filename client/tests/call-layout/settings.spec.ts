import { test, expect, type Page } from '@playwright/test';

// User settings and Server settings on the shared design system: no
// circles or pills, and on phones the section strip's entries are 44px.

async function roundThings(page: Page, root: string): Promise<string[]> {
  return page.locator(root).evaluate((el) => {
    const out: string[] = [];
    for (const n of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      const r = getComputedStyle(n).borderRadius;
      if (r.includes('%') || /(\d{2,})px/.test(r) && parseFloat(r) >= 9) out.push(`${n.className} ${r}`);
    }
    return out;
  });
}

for (const [name, w, h, plat] of [['desktop', 1440, 900, ''], ['iphone', 390, 844, '&platform=ios']] as const) {
  test(`user settings on ${name}: no circles or pills; switch rows`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/shots.html?view=settings&section=notifications${plat}`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: /^Notifications/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator('.bds-switch-row')).toHaveCount(8);
    expect(await roundThings(page, '.user-settings')).toEqual([]);
    if (name !== 'desktop') {
      // Layout height (the dialog may still be scaling in).
      const heights = await dialog.getByRole('tab').evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight));
      for (const hgt of heights) expect(hgt).toBeGreaterThanOrEqual(44);
    }
  });

  test(`server settings on ${name}: page header, nav rows, no circles`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/shots.html?view=services${plat}`);
    await expect(page.locator('.bds-page-head')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close settings' })).toHaveCount(1);
    await page.getByRole('tab', { name: /^Log/ }).click();
    await expect(page.getByText('No entries yet.')).toBeVisible();
    expect(await roundThings(page, 'main.server-settings')).toEqual([]);
  });
}
