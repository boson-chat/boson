// Phone, landscape and tablet fits: dialogs above the title bar, the ringing
// call in landscape, the mid-width (tablet portrait) layout, and channel
// settings on a small phone.
import { expect, test, type Locator, type Page } from '@playwright/test';

const CHAT = '/shots.html?view=chat&frame=1&friends=1&missed=1';

// The control is what a tap at its centre lands on (nothing covers it).
async function hittable(loc: Locator): Promise<void> {
  const ok = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (el === hit || el.contains(hit));
  });
  expect(ok).toBe(true);
}
async function inViewport(page: Page, loc: Locator): Promise<void> {
  const b = (await loc.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5);
}
const noSideScroll = async (page: Page, sel = 'html'): Promise<void> => {
  const over = await page.evaluate((s) => Math.max(...[...document.querySelectorAll(s)].map((e) => e.scrollWidth - e.clientWidth)), sel);
  expect(over).toBeLessThanOrEqual(0);
};

test.describe('phone (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the Join or create a channel dialog sits above the title bar: its title and Close are tappable', async ({ page }) => {
    await page.goto(`${CHAT}&platform=ios`);
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await page.getByRole('button', { name: 'Add channel', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /^Join (or create )?a channel$/ });
    await expect(dialog).toBeVisible();
    await hittable(dialog.getByRole('button', { name: 'Close' }));
    await hittable(dialog.locator('.bds-modal-title'));
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('small phone (360×800)', () => {
  test.use({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true });

  test('channel settings fit: no sideways scroll on either tab, role rows inside the screen', async ({ page }) => {
    await page.goto(`${CHAT}&chanserv=anope&platform=android`);
    await page.getByRole('button', { name: 'Channel settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Channel settings/ });
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(400);
    await noSideScroll(page, '.bds-modal-body');
    await dialog.getByRole('tab', { name: /Registration/i }).click();
    const rows = dialog.locator('.chan-roles .chan-role-row');
    await expect(rows.first()).toBeVisible();
    await noSideScroll(page, '.bds-modal-body');
    for (const row of await rows.all()) {
      const b = (await row.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(360.5);
    }
  });
});

test.describe('phone in landscape (844×390)', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

  test('an incoming call: Decline and Accept are on screen', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('boson:notifications:v1', JSON.stringify({ incomingCalls: 'full' })));
    await page.goto(`${CHAT}&notify=ring&platform=ios`);
    const ring = page.getByRole('alertdialog', { name: 'kestrel is calling' });
    await expect(ring).toBeVisible();
    await page.waitForTimeout(350);
    for (const name of ['Decline', 'Accept']) await inViewport(page, ring.getByRole('button', { name, exact: true }));
  });
});

test.describe('tablet portrait (768×1024)', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('the member list opens over the chat from the Members button', async ({ page }) => {
    await page.goto(CHAT);
    await expect(page.locator('.app-shell')).toHaveClass(/\bis-mid\b/);
    await expect(page.getByRole('complementary', { name: 'Members' })).toHaveCount(0);
    // The chat gets the room the member column had.
    expect((await page.locator('.chat-area').boundingBox())!.width).toBeGreaterThan(400);
    await page.getByRole('button', { name: /^Show members \(/ }).click();
    const panel = page.getByRole('complementary', { name: 'Members' });
    await expect(panel).toBeVisible();
    await inViewport(page, panel);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await noSideScroll(page);
  });

  test('in a call: the stage and its dock fit; no text chat, no call panel', async ({ page }) => {
    await page.goto('/shots.html?view=chat&voice=rooms&video=call&people=6');
    await page.locator('.channel-sidebar').getByText('General', { exact: true }).first().click();
    const join = page.getByRole('button', { name: 'Join call', exact: true });
    if (await join.count()) await join.first().click();
    const stage = page.locator('main.stage');
    await expect(stage).toBeVisible();
    await expect(page.locator('.callpanel')).toHaveCount(0);
    await inViewport(page, page.getByRole('toolbar', { name: 'Call controls' }).last());
    await inViewport(page, stage.getByRole('button', { name: 'Leave call' }));
    // General has no text chat, so there is no right panel (K1) and no
    // button to open one at this width.
    await expect(stage.getByRole('button', { name: 'Call chat' })).toHaveCount(0);
    await noSideScroll(page);
  });
});
