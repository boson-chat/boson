// The full-page conversation search on a phone (the mobile project: an
// iPhone's viewport, with touch), against the e2e ergo with ~1200 lines of
// server history (a CHATHISTORY proxy in front of it): the header's Search
// fills the screen, "Older results" pages back to the end of the history,
// tapping a result opens the conversation there, and "Back to results" /
// "Jump to latest" float over it.
import type { Page } from '@playwright/test';
import { test, expect, randomChannel, joinChannel } from './fixtures';
import { connectGuest, messages } from './helpers/chat';
import { startHistoryProxy, type HistoryProxy } from './helpers/history-proxy';
import { result, resultCount, searchBox, searchPage, searchToTheEnd, seedHistory } from './helpers/search';

async function openChannel(page: Page, ch: string): Promise<void> {
  const back = page.getByRole('button', { name: 'Back to channels' });
  if (await back.isVisible()) await back.click();
  await joinChannel(page, ch);
  await expect(page.locator('.app-shell')).toHaveClass(/\bphone-chat\b/);
}

test.describe('phone: conversation search', () => {
  let proxy: HistoryProxy | null = null;
  test.afterEach(async () => {
    await proxy?.close();
    proxy = null;
  });

  test('search fills the screen; a result opens in the conversation; back to results; jump to latest', async ({ launchApp }) => {
    test.setTimeout(180_000);
    proxy = await startHistoryProxy();
    const ch = randomChannel('psearch');
    seedHistory(proxy, ch);
    const { page } = await connectGuest(launchApp, { port: proxy.port });
    await openChannel(page, ch);
    await expect(messages(page).getByText('line 1199 of the backlog')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: `Search in ${ch}` }).click();
    await expect(searchPage(page)).toBeVisible();
    const box = (await searchPage(page).boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.width).toBeCloseTo(vp.width, 0);
    await expect(searchBox(page)).toBeFocused();
    // 44px targets.
    for (const name of ['Anyone', 'From…', 'Has link']) {
      expect((await searchPage(page).getByRole('button', { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await searchToTheEnd(page, proxy);

    // Tap an old result: the conversation, scrolled to it and marked.
    const list = searchPage(page).locator('.search-results');
    await result(page, 'needle 255 ').scrollIntoViewIfNeeded();
    const scrolled = await list.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await result(page, 'needle 255 ').getByRole('button').tap();
    await expect(searchPage(page)).toHaveCount(0);
    const row = messages(page).locator('.vrow-search-current');
    await expect(row).toContainText('needle 255 rotate the resolver keys');
    await expect(row).toBeInViewport();
    const back = page.getByRole('button', { name: 'Back to results' });
    const latest = page.getByRole('button', { name: 'Jump to latest' });
    await expect(back).toBeVisible();
    await expect(latest).toBeVisible();
    // Both on screen, side by side.
    for (const b of [back, latest]) {
      const r = (await b.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(vp.width);
    }

    // Back to results: the same query, results and place in the list.
    await back.tap();
    await expect(searchBox(page)).toHaveValue('needle');
    await expect(resultCount(page)).toHaveText('12 results');
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(scrolled);

    // Again, then Jump to latest: the newest lines, the pills gone.
    await result(page, 'needle 255 ').getByRole('button').tap();
    await expect(latest).toBeVisible();
    await latest.tap();
    await expect(messages(page).getByText('line 1199 of the backlog')).toBeInViewport();
    await expect(back).toHaveCount(0);
  });
});
