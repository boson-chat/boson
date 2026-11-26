// A late line older than what's in memory lands in time order: on top of
// the lines that come back from the store on scroll-up, not under them,
// and once. Seen through evrd on a phone: "test" at 08:04 shown under
// 08:14, 08:34 and later rows.
//
// ?order=1: #dev keeps a 40-line window over a store that answers late;
// the reconnect's backlog brings "test" (older than everything) while the
// window is refilling. window.__late sends another late line.
import { expect, test, type Page } from '@playwright/test';

const list = (page: Page) => page.locator('main .chat-messages');

// Wheel to the top until nothing older is left to load.
async function scrollToStart(page: Page): Promise<void> {
  const box = (await list(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 60 && (await list(page).evaluate((el) => el.scrollTop)) > 0; i++) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(500); // a page from the store (300 ms)
    if ((await list(page).evaluate((el) => el.scrollTop)) <= 0) break;
  }
}

// The y of the first row whose text is exactly `text`.
const rowY = (page: Page, text: string) => list(page).evaluate((el, t) => {
  for (const r of Array.from(el.querySelectorAll<HTMLElement>('.vrow'))) {
    if (Array.from(r.querySelectorAll('*')).some((n) => n.childElementCount === 0 && n.textContent?.trim() === t)) {
      return r.getBoundingClientRect().top;
    }
  }
  return null;
}, text);

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 760 }]) {
  test.describe(`late line order (${vp.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/shots.html?view=chat&frame=1&order=1', { waitUntil: 'domcontentloaded' });
      await expect(list(page).locator('.vrow').first()).toBeVisible();
      await page.waitForTimeout(800); // the window has refilled
    });

    test('a backlog line older than the held lines sits above them, once', async ({ page }) => {
      await scrollToStart(page);
      const test_ = await rowY(page, 'test');
      const automated = await rowY(page, "It's now automated. I have it flag accounts");
      const cool = await rowY(page, 'cool');
      const later = await rowY(page, 'earlier talk 0');
      expect(test_).not.toBeNull();
      expect(automated).not.toBeNull();
      expect(cool).not.toBeNull();
      expect(later).not.toBeNull();
      expect(test_!).toBeLessThan(automated!);
      expect(automated!).toBeLessThan(cool!);
      expect(cool!).toBeLessThan(later!);
      // One copy of each, though the backlog replayed "cool" too.
      const texts = await list(page).evaluate((el) => Array.from(el.querySelectorAll('.vrow *'))
        .filter((n) => n.childElementCount === 0).map((n) => n.textContent?.trim() ?? ''));
      expect(texts.filter((t) => t === 'test')).toHaveLength(1);
      expect(texts.filter((t) => t === 'cool')).toHaveLength(1);
      await page.screenshot({ path: test.info().outputPath('top.png') });
    });

    test('a late line arriving while scrolled up does not move what is being read', async ({ page }) => {
      const box = (await list(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -500);
      await page.waitForTimeout(300);
      const key = await list(page).evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const r = Array.from(el.querySelectorAll<HTMLElement>('.vrow')).find((x) => x.getBoundingClientRect().top >= top);
        return r ? { key: r.dataset['vkey']!, top: r.getBoundingClientRect().top } : null;
      });
      expect(key).not.toBeNull();
      await page.evaluate(() => (window as unknown as { __late: (t: string, m: number) => void }).__late('late again', 125));
      await page.waitForTimeout(300);
      const after = await list(page).evaluate((el, k) => el.querySelector<HTMLElement>(`.vrow[data-vkey="${k}"]`)?.getBoundingClientRect().top ?? null, key!.key);
      expect(after).not.toBeNull();
      expect(Math.abs(after! - key!.top)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath('scrolled.png') });
      // It comes back in its place on the way up.
      await scrollToStart(page);
      const late = await rowY(page, 'late again');
      expect(late).not.toBeNull();
      expect(late!).toBeGreaterThan((await rowY(page, 'test'))!);
      expect(late!).toBeLessThan((await rowY(page, "It's now automated. I have it flag accounts"))!);
    });
  });
}
