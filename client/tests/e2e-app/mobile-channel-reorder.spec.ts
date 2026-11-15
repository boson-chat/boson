// Channel reordering on the phone layout: press and hold a channel, then
// drag it (a plain swipe still scrolls the list); the order survives a reload.
import type { CDPSession, Locator, Page } from '@playwright/test';
import {
  test, expect, IRC_HOST, IRC_PORT, uid, randomChannel,
  continueAsGuest, addServerManually, serverCard, joinChannel,
} from './fixtures';

const sidebar = (page: Page): Locator => page.locator('.channel-sidebar');
const row = (page: Page, channel: string): Locator =>
  sidebar(page).locator(`.channel-item[data-reorder-key="${channel.toLowerCase()}"]`);
const order = (page: Page): Promise<string[]> =>
  sidebar(page).locator('.channel-item[data-reorder-section="channels"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['reorderName']!));

const shell = (page: Page): Locator => page.locator('.app-shell');

async function openChannels(page: Page): Promise<void> {
  if (!/\bdrawer-nav\b/.test((await shell(page).getAttribute('class')) ?? '')) {
    await page.getByRole('button', { name: 'Channels' }).click();
  }
  await expect(shell(page)).toHaveClass(/\bdrawer-nav\b/);
  await expect(page.getByRole('button', { name: 'Add channel' })).toBeVisible();
}

async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] });
}

test('press and hold, then drag a channel; the order survives a reload', async ({ launchApp }) => {
  const { page } = await launchApp();
  await continueAsGuest(page, `mor${uid()}`);
  const name = `Phone Order ${uid(4)}`;
  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name, tls: false });
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  const [a, b, c] = [randomChannel('pa'), randomChannel('pb'), randomChannel('pc')];
  for (const ch of [a, b, c]) {
    // Joining shows the chat; the channel list is the drawer under it.
    await openChannels(page);
    await joinChannel(page, ch);
  }
  await openChannels(page);
  await expect(row(page, a)).toBeVisible();
  await expect.poll(() => order(page)).toEqual([a, b, c]);

  const cdp = await page.context().newCDPSession(page);
  // A quick swipe over the rows doesn't pick one up.
  const pa = await centre(row(page, a));
  await touch(cdp, 'touchStart', pa);
  await touch(cdp, 'touchMove', { x: pa.x, y: pa.y + 40 });
  await page.waitForTimeout(600);
  await expect(sidebar(page).locator('.channel-item-dragging')).toHaveCount(0);
  await touch(cdp, 'touchEnd');

  // Hold #c, then drag it above #a.
  const pc = await centre(row(page, c));
  const top = (await row(page, a).boundingBox())!;
  await touch(cdp, 'touchStart', pc);
  await page.waitForTimeout(600);
  await expect(row(page, c)).toHaveClass(/channel-item-dragging/);
  for (let i = 1; i <= 8; i++) {
    await touch(cdp, 'touchMove', { x: pc.x, y: Math.round(pc.y + ((top.y + 4 - pc.y) * i) / 8) });
  }
  await expect(row(page, a)).toHaveClass(/channel-item-drop-before/);
  await expect(page.locator('.channel-reorder-ghost')).toHaveText(c);
  await page.screenshot({ path: test.info().outputPath('touch-drag.png'), animations: 'disabled' });
  await touch(cdp, 'touchEnd');
  await expect.poll(() => order(page)).toEqual([c, a, b]);
  // The drawer stayed open (the drag wasn't taken for a swipe) and the
  // release didn't open the channel.
  await expect(shell(page)).toHaveClass(/\bdrawer-nav\b/);
  await cdp.detach();

  await page.reload();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  await openChannels(page);
  await expect.poll(() => order(page), { timeout: 20_000 }).toEqual([c, a, b]);
});
