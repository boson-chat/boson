// The phone layout (the mobile project: an iPhone's viewport, with touch).
// Below 700px the chat layout shows one pane at a time — the server rail
// with the channel list, the chat, or the member list — and dialogs are
// full-screen sheets. The e2e app runs in Chromium, so this checks the
// responsive layout; WebKit and the native shells are checked by hand.
import type { Page } from '@playwright/test';
import { test, expect, uid, IRC_HOST, IRC_PORT, continueAsGuest, addServerManually, serverCard, joinChannel } from './fixtures';

const visible = (page: Page, sel: string) => page.locator(sel).first().isVisible();
// Nothing makes the page wider than the screen (WebKit would let it pan).
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('phone layout', () => {
  test('one pane at a time: channels → chat → members and back', async ({ launchApp }) => {
    const { page } = await launchApp();
    await continueAsGuest(page, `mb${uid()}`);
    const name = `Phone Ergo ${uid(4)}`;
    await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name, tls: false });
    await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();

    expect(await fitsWidth(page)).toBe(true);
    // Connected: the channel list fills the screen, with the server rail.
    await expect(page.locator('.channel-sidebar')).toBeVisible({ timeout: 30_000 });
    expect(await visible(page, '.server-rail')).toBe(true);
    expect(await visible(page, '.chat-area')).toBe(false);
    expect(await visible(page, '.user-panel')).toBe(false);
    const width = page.viewportSize()!.width;
    const sidebar = await page.locator('.channel-sidebar').boundingBox();
    expect(sidebar!.x + sidebar!.width).toBeGreaterThan(width - 2);

    // Joining a channel shows its chat, full width, with a way back.
    const channel = `#phone-${uid(6)}`;
    await joinChannel(page, channel);
    await expect(page.locator('.chat-area')).toBeVisible();
    expect(await visible(page, '.channel-sidebar')).toBe(false);
    expect(await visible(page, '.server-rail')).toBe(false);
    const chat = await page.locator('.chat-area').boundingBox();
    expect(chat!.width).toBeGreaterThan(width - 2);

    // Members: their own pane, and back to the chat.
    expect(await fitsWidth(page)).toBe(true);
    await page.getByRole('button', { name: /^Members \(/ }).click();
    await expect(page.locator('.user-panel')).toBeVisible();
    expect(await visible(page, '.chat-area')).toBe(false);
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(page.locator('.chat-area')).toBeVisible();

    // Back to the channel list; picking the channel again opens its chat.
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await expect(page.locator('.channel-sidebar')).toBeVisible();
    expect(await visible(page, '.chat-area')).toBe(false);
    await page.locator('.channel-sidebar').getByText(channel.slice(1), { exact: true }).click();
    await expect(page.locator('.chat-area')).toBeVisible();
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
