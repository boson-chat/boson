// Loading older messages moves nothing on screen: the line being read
// stays where it was when a page comes in above it, and a page that
// arrives while the user is still scrolling (a finger down, a fling)
// waits for the scroll to stop rather than writing scrollTop under it.
//
// ?search=1: the harness server keeps CHATHISTORY for #dev and answers
// BEFORE after 350 ms.
import { expect, test, type Page } from '@playwright/test';

const list = (page: Page) => page.locator('main .chat-messages');
const ribbon = (page: Page) => list(page).locator('.chat-load-older');

// The row at the top of the viewport (below the ribbon) and where it is.
const topRow = (page: Page) => list(page).evaluate((el) => {
  const box = el.getBoundingClientRect();
  for (const r of Array.from(el.querySelectorAll<HTMLElement>('.vrow'))) {
    const b = r.getBoundingClientRect();
    if (b.top >= box.top) return { key: r.dataset['vkey']!, top: b.top };
  }
  return null;
});
const rowTop = (page: Page, key: string) => list(page).evaluate((el, k) => {
  const row = el.querySelector<HTMLElement>(`.vrow[data-vkey="${k}"]`);
  return row ? row.getBoundingClientRect().top : null;
}, key);
const rowCount = (page: Page) => list(page).evaluate((el) => el.scrollHeight);

// Wheel up to the top: the load starts there.
async function wheelToTop(page: Page): Promise<void> {
  const box = (await list(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 60 && (await list(page).evaluate((el) => el.scrollTop)) > 0; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(16);
  }
}

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 760 }]) {
  test.describe(`load older (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/shots.html?view=chat&frame=1&search=1', { waitUntil: 'domcontentloaded' });
      await expect(list(page).locator('.vrow').first()).toBeVisible();
      await page.waitForTimeout(800); // the latest page is in
    });

    test('the line being read stays put when the page comes in', async ({ page }) => {
      await wheelToTop(page);
      await expect(ribbon(page)).toContainText('Loading older messages');
      const before = (await topRow(page))!;
      await expect(ribbon(page)).toContainText('Loaded older messages');
      await page.waitForTimeout(300);
      expect(Math.abs((await rowTop(page, before.key))! - before.top)).toBeLessThanOrEqual(1);
      expect(await list(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
      await page.screenshot({ path: test.info().outputPath('loaded.png') });
    });

    test('a page that arrives mid-scroll waits for the scroll to stop', async ({ page }) => {
      await wheelToTop(page);
      await expect(ribbon(page)).toContainText('Loading older messages');
      // A finger goes down on the list (and stays) before the page lands.
      await list(page).evaluate((el) => el.dispatchEvent(new Event('touchstart')));
      const before = (await topRow(page))!;
      const height = await rowCount(page);
      await page.waitForTimeout(800); // the server has answered
      // Held: nothing above, nothing moved, still shown as loading.
      expect(await rowCount(page)).toBe(height);
      expect(Math.abs((await rowTop(page, before.key))! - before.top)).toBeLessThanOrEqual(1);
      await expect(ribbon(page)).toContainText('Loading older messages');
      // Finger up: the page goes in above, the row read stays where it was.
      await list(page).evaluate((el) => el.dispatchEvent(new Event('touchend')));
      await expect(ribbon(page)).toContainText('Loaded older messages');
      await page.waitForTimeout(300);
      expect(await rowCount(page)).toBeGreaterThan(height + 1000);
      expect(Math.abs((await rowTop(page, before.key))! - before.top)).toBeLessThanOrEqual(1);
    });

    test('held lines go in after a while even without the finger coming up', async ({ page }) => {
      await wheelToTop(page);
      await list(page).evaluate((el) => el.dispatchEvent(new Event('touchstart')));
      const before = (await topRow(page))!;
      const height = await rowCount(page);
      await expect.poll(() => rowCount(page), { timeout: 4000 }).toBeGreaterThan(height + 1000);
      await page.waitForTimeout(200);
      expect(Math.abs((await rowTop(page, before.key))! - before.top)).toBeLessThanOrEqual(1);
    });
  });
}
