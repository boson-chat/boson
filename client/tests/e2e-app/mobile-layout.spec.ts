// The phone layout (the mobile project: an iPhone's viewport, with touch).
// Below 700px the desktop's columns show one at a time: the slim rail
// beside the full-width channel list, or a page full screen with a back
// arrow (a conversation, its members), and swipes between them; no
// bottom bar.
// Dialogs are full-screen sheets. The e2e app runs in Chromium, so this
// checks the responsive layout; WebKit and the native shells are checked
// by hand.
import type { Page } from '@playwright/test';
import { test, expect, uid, IRC_HOST, IRC_PORT, continueAsGuest, addServerManually, serverCard, joinChannel, webBrowserSkip } from './fixtures';

const shell = (page: Page) => page.locator('.app-shell');
const screenIs = (page: Page, d: 'home' | 'chat' | 'members') =>
  expect(shell(page)).toHaveClass(new RegExp(`\\bphone-${d}\\b`));
// Nothing makes the page wider than the screen (WebKit would let it pan).
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// A one-finger drag, as real touch events (Playwright's touchscreen only taps).
async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function connectGuestPhone(page: Page): Promise<string> {
  await continueAsGuest(page, `mb${uid()}`);
  const name = `Phone Ergo ${uid(4)}`;
  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name, tls: false });
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  return name;
}

test.describe('phone layout', () => {
  test('the rail and channel list, then a channel full screen with a back arrow', async ({ launchApp }) => {
    webBrowserSkip('firefox', 'touch gestures go through the Chromium DevTools protocol (Input.dispatchTouchEvent), which Playwright has only in Chromium');
    webBrowserSkip('webkit', 'touch gestures go through the Chromium DevTools protocol (Input.dispatchTouchEvent), which Playwright has only in Chromium');
    const { page } = await launchApp();
    await connectGuestPhone(page);
    const { width } = page.viewportSize()!;

    // No channel yet: the slim rail (MY, SERVERS, the server) beside the
    // channel list, which takes the rest of the width.
    await screenIs(page, 'home');
    const rail = (await page.locator('.server-rail').boundingBox())!;
    const list = (await page.locator('.channel-sidebar').boundingBox())!;
    expect(rail.width).toBeLessThanOrEqual(64);
    expect(list.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
    expect(list.x + list.width).toBeGreaterThan(width - 2);
    await expect(page.getByRole('button', { name: /^You: friends, calls and messages/ })).toBeVisible();
    await expect(page.locator('.rail-divider-label')).toHaveText('SERVERS');
    // No bottom bar, no peek strip of a chat.
    await expect(page.locator('.phone-tabs')).toHaveCount(0);
    await expect(page.locator('.chat-area')).toHaveCount(0);
    expect(await fitsWidth(page)).toBe(true);

    // A channel: its chat, full screen.
    const channel = `#phone-${uid(6)}`;
    await joinChannel(page, channel);
    await screenIs(page, 'chat');
    expect((await page.locator('.chat-area').boundingBox())!.width).toBeGreaterThan(width - 2);
    await expect(page.locator('.server-rail')).toHaveCount(0);
    expect(await fitsWidth(page)).toBe(true);

    // Back: the channel list; picking the channel opens it again.
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await screenIs(page, 'home');
    await page.locator('.channel-sidebar').getByText(channel.slice(1), { exact: true }).click();
    await screenIs(page, 'chat');

    // Members, full screen; back to the chat.
    await page.getByRole('button', { name: /^Members \(/ }).click();
    await screenIs(page, 'members');
    await expect(page.locator('.user-panel')).toBeVisible();
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await screenIs(page, 'chat');

    // Swipes: right for the channels, left back to the chat, left for the
    // members, right back; a short slow drag and a vertical one stay put.
    const { height } = page.viewportSize()!;
    const y = Math.round(height / 2);
    await swipe(page, { x: 40, y }, { x: width - 40, y });
    await screenIs(page, 'home');
    await swipe(page, { x: width - 40, y }, { x: 40, y });
    await screenIs(page, 'chat');
    await swipe(page, { x: width - 40, y }, { x: 40, y });
    await screenIs(page, 'members');
    await swipe(page, { x: 40, y }, { x: width - 40, y });
    await screenIs(page, 'chat');
    await swipe(page, { x: 40, y }, { x: 90, y }, 20);
    await screenIs(page, 'chat');
    await swipe(page, { x: width / 2, y: height - 200 }, { x: width / 2 + 20, y: 150 });
    await screenIs(page, 'chat');

    // MY: Friends and Calls above the direct messages.
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await page.getByRole('button', { name: /^You: friends, calls and messages/ }).click();
    await expect(page.locator('.my-sidebar .my-row').getByRole('button').first()).toHaveAccessibleName(/^Friends/);
    await page.getByRole('button', { name: /^Calls/ }).click();
    await expect(page.getByRole('main', { name: 'Calls' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to MY' }).click();
    await screenIs(page, 'home');
  });

  test('a relaunch opens straight onto the last channel', async ({ launchApp }) => {
    const first = await launchApp();
    await connectGuestPhone(first.page);
    const channel = `#phone-${uid(6)}`;
    await joinChannel(first.page, channel);
    await first.app.close();

    const { page } = await launchApp();
    await expect(page.locator('.chat-channel-label')).toHaveText(channel.slice(1), { timeout: 30_000 });
    await screenIs(page, 'chat');
  });

  test('dialogs are full-screen sheets', async ({ launchApp }) => {
    const { page } = await launchApp();
    await continueAsGuest(page, `md${uid()}`);
    await page.getByRole('button', { name: /^User settings/ }).click();
    const dialog = page.getByRole('dialog', { name: 'User settings' });
    await expect(dialog).toBeVisible();
    // (After the open animation, which starts the sheet slightly scaled down.)
    const vp = page.viewportSize()!;
    await expect.poll(async () => (await dialog.boundingBox())!.width).toBeGreaterThan(vp.width - 2);
    await expect.poll(async () => (await dialog.boundingBox())!.height).toBeGreaterThan(vp.height - 2);
    // The section menu runs across the top, above the section.
    const menu = await dialog.locator('.user-settings-menu').boundingBox();
    const body = await dialog.locator('.user-settings-body').boundingBox();
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(body!.y + 1);
  });
});
