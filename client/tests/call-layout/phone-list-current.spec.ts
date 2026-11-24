// Back on a phone's channel list (the back arrow or a swipe right), the list
// opens on the channel you were in, not at its top, and only the list
// scrolls: the page stays put.
import { expect, test, type Page } from '@playwright/test';

const URL = '/shots.html?view=chat&voice=rooms&friends=1&frame=1&platform=ios&chans=24';
const shell = (page: Page) => page.locator('.app-shell');

// The open channel's row lies inside the list's visible box.
async function currentRowShows(page: Page): Promise<void> {
  const list = page.locator('.phone-layer-cur .channel-sidebar .channel-list');
  const row = list.locator('.channel-item-active');
  await expect(row).toContainText('room-24');
  const m = await list.evaluate((el) => {
    const r = el.querySelector('.channel-item-active')!.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { top: r.top - b.top, bottom: b.bottom - r.bottom, scrolled: el.scrollTop, pageY: window.scrollY };
  });
  expect(m.scrolled, 'the list scrolled down to it').toBeGreaterThan(0);
  expect(m.top).toBeGreaterThanOrEqual(0);
  expect(m.bottom).toBeGreaterThanOrEqual(0);
  expect(m.pageY, 'the page itself did not scroll').toBe(0);
}

test('the back arrow opens the channel list on the current channel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  {
    await page.goto(URL);
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await expect(shell(page)).toHaveClass(/\bphone-home\b/);
    await currentRowShows(page);
    await page.screenshot({ path: test.info().outputPath('list-on-current.png') });
  }
});

test.describe('swipe', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test.skip(({ browserName }) => browserName !== 'chromium', 'touch drags need the Chromium DevTools protocol');

  test('a swipe right opens the channel list on the current channel', async ({ page }) => {
    await page.goto(URL);
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 40, y: 420 }] });
    for (const x of [80, 140, 200, 280, 340]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 420 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await expect(shell(page)).toHaveClass(/\bphone-home\b/);
    await currentRowShows(page);
  });
});
