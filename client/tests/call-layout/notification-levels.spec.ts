// Notifications per server and per channel: Server settings → Notifications
// sets what the server's channels and DMs notify about; a channel can have
// its own level (Channel settings, or its context menu) over the server's,
// and lists under the server with a way back to the server's.
import { expect, test, type Page } from '@playwright/test';

const SERVER = '/shots.html?view=services&section=notifications';
const CHAT = '/shots.html?view=chat&frame=1&platform=ios';
const LEVELS = 'boson:notifications:channels:v1';
const SERVERS = 'boson:notifications:servers:v1';

const saved = (page: Page, key: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), key);

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }]) {
  test(`${vp.name}: server settings set the server's levels and list channels with their own`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.addInitScript(([k]) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem(k!, JSON.stringify({ 's1\u0000#ops': 'all', 's1\u0000mira': 'nothing' }));
        sessionStorage.setItem('seeded', '1');
      }
    }, [LEVELS]);
    await page.goto(SERVER);
    const dialog = page.getByRole('dialog');
    const channels = dialog.getByRole('radiogroup', { name: 'Channels' });
    const dms = dialog.getByRole('radiogroup', { name: 'Direct messages' });
    await expect(channels.getByRole('radio', { name: 'Mentions' })).toBeChecked();
    await expect(dms.getByRole('radio', { name: 'All' })).toBeChecked();
    await expect(dialog.getByText('Channels with their own setting')).toBeVisible();
    await expect(dialog.getByText('#ops')).toBeVisible();
    await expect(dialog.getByText('mira')).toBeVisible();

    await channels.getByRole('radio', { name: 'Nothing' }).click();
    await dms.getByRole('radio', { name: 'Nothing' }).click();
    expect(await saved(page, SERVERS)).toEqual({ s1: { channels: 'nothing', dms: 'nothing' } });
    await page.waitForTimeout(300); // the segmented control's transition
    await page.screenshot({ path: test.info().outputPath('server-notifications.png') });

    // Back to the server's: off the list.
    await dialog.getByRole('button', { name: "Use server's" }).first().click();
    await expect(dialog.getByText('#ops')).toHaveCount(0);
    expect(await saved(page, LEVELS)).toEqual({ 's1\u0000mira': 'nothing' });
  });
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test("channel settings: the server's default, or the channel's own level", async ({ page }) => {
  await page.addInitScript(([k]) => localStorage.setItem(k!, JSON.stringify({ s1: { channels: 'all' } })), [SERVERS]);
  await page.goto(CHAT);
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name: 'Channel settings' }).click();
  const dialog = page.getByRole('dialog', { name: /Channel settings/ });
  const select = dialog.getByRole('button', { name: /^Notifications/ });
  await expect(select).toHaveText(/Server default \(All messages\)/);
  await select.click();
  await page.getByRole('option', { name: 'Nothing' }).click();
  await expect(select).toHaveText(/Nothing/);
  expect(await saved(page, LEVELS)).toEqual({ 's1\u0000#dev': 'nothing' });
  await page.screenshot({ path: test.info().outputPath('channel-notifications.png') });
  await select.click();
  await page.getByRole('option', { name: /Server default/ }).click();
  expect(await saved(page, LEVELS)).toEqual({});
});
});
