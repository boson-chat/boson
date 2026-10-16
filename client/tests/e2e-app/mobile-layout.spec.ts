// The phone layout (the mobile project: an iPhone's viewport, with touch).
// Below 700px the chat fills the screen, Discord style: the server rail with
// the channel list and the member list are drawers under it, revealed by
// swiping the chat aside (or from the chat header); dialogs are full-screen
// sheets. The e2e app runs in Chromium, so this checks the responsive
// layout and the touch handling; WebKit and the native shells are checked
// by hand.
import type { Page } from '@playwright/test';
import { test, expect, uid, IRC_HOST, IRC_PORT, continueAsGuest, addServerManually, serverCard, joinChannel } from './fixtures';

const shell = (page: Page) => page.locator('.app-shell');
const drawer = (page: Page, d: 'none' | 'nav' | 'members') =>
  expect(shell(page)).toHaveClass(new RegExp(`\\bdrawer-${d}\\b`));
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
  test('the chat fills the screen; swipes reveal the channels and the members', async ({ launchApp }) => {
    const { page } = await launchApp();
    await connectGuestPhone(page);
    const { width, height } = page.viewportSize()!;
    const mid = { y: Math.round(height / 2) };

    // No channel yet: the channels show.
    await drawer(page, 'nav');
    await expect(page.locator('.channel-sidebar')).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);

    // A channel: its chat, full screen.
    const channel = `#phone-${uid(6)}`;
    await joinChannel(page, channel);
    await drawer(page, 'none');
    // (Once the slide back has finished.)
    await expect.poll(async () => (await page.locator('.mobile-main').boundingBox())!.x).toBeLessThan(1);
    expect((await page.locator('.mobile-main').boundingBox())!.width).toBeGreaterThan(width - 2);
    expect(await fitsWidth(page)).toBe(true);

    // Swipe right: the chat slides aside to the channels, leaving a sliver.
    await swipe(page, { x: 40, y: mid.y }, { x: width - 40, y: mid.y });
    await drawer(page, 'nav');
    await expect(page.locator('.channel-sidebar')).toBeVisible();
    await expect.poll(async () => (await page.locator('.mobile-main').boundingBox())!.x).toBeGreaterThan(width - 80);
    // Tapping the sliver brings the chat back.
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await drawer(page, 'none');

    // Swipe left: the members; swipe back right: the chat.
    await swipe(page, { x: width - 40, y: mid.y }, { x: 40, y: mid.y });
    await drawer(page, 'members');
    await expect(page.locator('.user-panel')).toBeVisible();
    await swipe(page, { x: 20, y: mid.y }, { x: width - 20, y: mid.y });
    await drawer(page, 'none');

    // A short, slow drag springs back.
    await swipe(page, { x: 40, y: mid.y }, { x: 90, y: mid.y }, 20);
    await drawer(page, 'none');

    // A vertical drag is the message list's scroll, not a drawer.
    await swipe(page, { x: width / 2, y: height - 200 }, { x: width / 2 + 20, y: 150 });
    await drawer(page, 'none');

    // The header buttons do the same: channels, then pick the channel.
    await page.getByRole('button', { name: 'Channels' }).click();
    await drawer(page, 'nav');
    await page.locator('.channel-sidebar').getByText(channel.slice(1), { exact: true }).click();
    await drawer(page, 'none');
    await page.getByRole('button', { name: /^Members \(/ }).click();
    await drawer(page, 'members');
    await page.getByRole('button', { name: 'Back to chat' }).first().click();
    await drawer(page, 'none');
  });

  test('a relaunch opens straight onto the last channel', async ({ launchApp }) => {
    const first = await launchApp();
    await connectGuestPhone(first.page);
    const channel = `#phone-${uid(6)}`;
    await joinChannel(first.page, channel);
    await first.app.close();

    const { page } = await launchApp();
    await expect(page.locator('.chat-channel-label')).toHaveText(channel.slice(1), { timeout: 30_000 });
    await drawer(page, 'none');
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
