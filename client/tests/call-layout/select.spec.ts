import { test, expect, type Locator, type Page } from '@playwright/test';

// The design system's Select (every dropdown in the app): a button that
// opens a listbox above Modals, flips up near the viewport's bottom, and is
// a bottom Sheet on phones.

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('no box');
  return b;
}

async function onTop(page: Page, l: Locator): Promise<boolean> {
  const b = await box(l);
  return page.evaluate(([x, y]) => {
    const hit = document.elementFromPoint(x!, y!);
    return !!hit?.closest('[role="listbox"]');
  }, [b.x + b.width / 2, b.y + b.height / 2]);
}

test('in a modal: opens above it, keyboard picks, Escape closes only the list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/shots.html?view=chat&voice=manage');
  await page.getByRole('button', { name: 'Create a voice channel in #dev', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a voice channel' });
  await expect(dialog).toBeVisible();
  const join = dialog.getByLabel('Who can join');
  await expect(join).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(join).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('select').count()).toBe(0);

  await join.click();
  const list = page.getByRole('listbox', { name: 'Who can join' });
  await expect(list).toBeVisible();
  await expect(join).toHaveAttribute('aria-expanded', 'true');
  await expect(list).toBeFocused();
  // Not clipped by the dialog: the list is on top at its own centre.
  expect(await onTop(page, list)).toBe(true);
  const lb = await box(list);
  expect(lb.y + lb.height).toBeLessThanOrEqual(900);

  const before = (await join.textContent())!.trim();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(join).toBeFocused();
  await expect(join).not.toHaveText(before);

  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(join).toBeFocused();

  // A click on an option picks it.
  await join.click();
  await page.getByRole('option').last().click();
  await expect(list).toBeHidden();
});

test('near the bottom of the viewport it opens upward', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto('/shots.html?view=settings&section=chat&images=1');
  const keep = page.getByLabel('Image cache size');
  await keep.scrollIntoViewIfNeeded();
  // Pin it to the bottom edge of the window, as at the end of a long form.
  await keep.evaluate((el) => (el as HTMLElement).closest('.bds-modal-body, .user-settings-content')?.scrollBy(0, 10_000));
  const tb = await box(keep);
  await keep.click();
  const list = page.getByRole('listbox', { name: 'Image cache size' });
  await expect(list).toBeVisible();
  const lb = await box(list);
  expect(lb.y).toBeGreaterThanOrEqual(0);
  expect(lb.y + lb.height).toBeLessThanOrEqual(640);
  if (640 - (tb.y + tb.height) < lb.height + 12) expect(lb.y + lb.height).toBeLessThanOrEqual(tb.y);
  expect(await onTop(page, list)).toBe(true);
  await page.getByRole('option', { name: /1 GB/ }).click();
  await expect(keep).toHaveText(/1 GB/);
});

test('on a phone it is a bottom sheet with 44px options', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/shots.html?view=settings&section=chat&images=1&platform=ios');
  const keep = page.getByLabel('Image cache size');
  await keep.scrollIntoViewIfNeeded();
  await keep.click();
  const sheet = page.getByRole('dialog', { name: 'Image cache size' });
  await expect(sheet).toBeVisible();
  const options = sheet.getByRole('option');
  await expect(options).toHaveCount(4);
  for (const h of await options.evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight))) expect(h).toBeGreaterThanOrEqual(44);
  await sheet.getByRole('option', { name: /2 GB/ }).click();
  await expect(sheet).toBeHidden();
  await expect(keep).toHaveText(/2 GB/);
});
