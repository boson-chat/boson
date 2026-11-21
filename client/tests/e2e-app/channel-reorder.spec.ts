// Channel list reordering: drag a channel to a new place in the sidebar (and
// Alt+Up/Down, and the row menu's Reset order); the order is saved with the
// session, per server, so it survives a reload and a relaunch.
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, IRC_HOST, IRC_PORT, uid, randomChannel,
  continueAsGuest, addServerManually, serverCard, joinChannel, webBrowserFixme } from './fixtures';

const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Channels' });
const channelRows = (page: Page): Locator => sidebar(page).locator('.channel-item[data-reorder-section="channels"]');
const row = (page: Page, channel: string): Locator =>
  sidebar(page).locator(`.channel-item[data-reorder-key="${channel.toLowerCase()}"]`);
const order = (page: Page): Promise<string[]> =>
  channelRows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['reorderName']!));

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(name), animations: 'disabled' });
}

test('drag channels into a new order; it survives a reload and a relaunch', async ({ launchApp }) => {
  webBrowserFixme('webkit', 'the drop does not reorder in WebKit (pointer drag); to fix');
  const nick = `ord${uid()}`;
  const serverName = `Order Ergo ${uid(4)}`;
  const [a, b, c] = [randomChannel('ra'), randomChannel('rb'), randomChannel('rc')];

  const first = await launchApp();
  let page = first.page;
  await continueAsGuest(page, nick);
  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: serverName, tls: false });
  await serverCard(page, serverName).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  for (const ch of [a, b, c]) await joinChannel(page, ch);
  // Default: the order they were joined in.
  await expect.poll(() => order(page)).toEqual([a, b, c]);

  // Drag #c above #a, step by step so the drop line can be checked (and
  // photographed) mid-drag.
  const from = (await row(page, c).boundingBox())!;
  const to = (await row(page, a).boundingBox())!;
  await row(page, c).hover({ position: { x: 40, y: from.height / 2 } });
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2 - 6, { steps: 3 });
  await page.mouse.move(to.x + 40, to.y + 4, { steps: 8 });
  await expect(row(page, c)).toHaveClass(/channel-item-dragging/);
  await expect(row(page, a)).toHaveClass(/channel-item-drop-before/);
  await shot(page, 'drag-over.png');
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([c, a, b]);
  await expect(sidebar(page).locator('.channel-item-drop-before, .channel-item-drop-after')).toHaveCount(0);
  await shot(page, 'dropped.png');

  // Keyboard: Alt+Down on the focused #a moves it below #b, focus stays on it.
  await row(page, a).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => order(page)).toEqual([c, b, a]);
  await expect(row(page, a)).toBeFocused();

  // A reload (the renderer starts over from the saved session).
  await page.reload();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  await expect.poll(() => order(page), { timeout: 20_000 }).toEqual([c, b, a]);

  // A relaunch on the same profile.
  await first.app.close();
  const second = await launchApp();
  page = second.page;
  await expect(page.locator('.sidebar-server-name')).toHaveText(serverName, { timeout: 30_000 });
  await expect.poll(() => order(page), { timeout: 30_000 }).toEqual([c, b, a]);

  // A channel joined now goes at the end; leaving one drops it out.
  const d = randomChannel('rd');
  await joinChannel(page, d);
  await expect.poll(() => order(page)).toEqual([c, b, a, d]);
  await row(page, b).hover();
  await row(page, b).getByRole('button', { name: `Leave ${b}` }).click();
  await expect.poll(() => order(page)).toEqual([c, a, d]);

  // Reset order (row menu): back to the default, join order.
  await row(page, a).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset order' }).click();
  await expect.poll(() => order(page)).toEqual([a, c, d]);
});
