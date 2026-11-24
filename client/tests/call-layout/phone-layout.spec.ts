// The phone layout matches the desktop's, without its top bar: the slim
// rail (you, the bell, SERVERS, the servers, "+") beside the full-width
// channel list, whose server header comes first, as tall as a
// conversation's; pages full screen with a back arrow. No bottom bar, no
// drawer with a strip of the chat.
import { expect, test, type Page } from '@playwright/test';

const PHONES = [[390, 844, 'iphone'], [360, 800, 'android']] as const;
const shell = (page: Page) => page.locator('.app-shell');
// Nothing wider than the phone: no sideways scroll, every screen inside it.
async function fits(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth - innerWidth,
    widest: Math.max(...[...document.querySelectorAll('.app-shell > *, .phone-screen > *, .phone-page, .mcall, .title-bar')].map((e) => e.getBoundingClientRect().right)),
    vw: innerWidth,
  }));
  expect(m.scroll).toBeLessThanOrEqual(0);
  expect(m.widest).toBeLessThanOrEqual(m.vw + 0.5);
}

for (const [w, h, phone] of PHONES) {
  test(`${phone} (${w}×${h}): no top bar, the slim rail with the bell and the channel list; channels open full screen`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/shots.html?view=chat&voice=rooms&friends=1&missed=1&frame=1&platform=${phone === 'iphone' ? 'ios' : 'android'}`);
    // A launch opens onto the last channel; back shows the list.
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await expect(shell(page)).toHaveClass(/\bphone-home\b/);

    const m = await page.evaluate(() => {
      const r = (s: string) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return {
        bar: r('.title-bar'), rail: r('.server-rail'), list: r('.channel-sidebar'), head: r('.channel-sidebar-header'),
        you: r('.server-rail .my-tile'), bell: r('.server-rail .rail-bell'), divider: r('.server-rail .rail-divider'),
        tabs: document.querySelectorAll('.phone-tabs').length, chat: document.querySelectorAll('.chat-area').length,
        controls: document.querySelectorAll('.title-bar-btn').length, scroll: document.documentElement.scrollWidth - innerWidth,
      };
    });
    // No top bar, no window controls; nothing at the bottom.
    expect(m.bar).toBeNull();
    expect(m.controls).toBe(0);
    expect(m.tabs).toBe(0);
    expect(m.chat).toBe(0);
    expect(m.scroll).toBeLessThanOrEqual(0);
    // The slim rail and the list, from the top, the list to the edge.
    expect(m.rail!.w).toBeLessThanOrEqual(64);
    expect(m.rail!.y).toBe(0);
    expect(m.head!.y).toBe(0);
    expect(m.list!.x).toBeGreaterThanOrEqual(m.rail!.x + m.rail!.w - 1);
    expect(m.list!.x + m.list!.w).toBeGreaterThan(w - 2);
    // The bell: under you, above SERVERS, a 44px target.
    expect(m.bell!.y).toBeGreaterThanOrEqual(m.you!.y + m.you!.h);
    expect(m.divider!.y).toBeGreaterThanOrEqual(m.bell!.y + m.bell!.h);
    expect(m.bell!.w).toBeGreaterThanOrEqual(44);
    expect(m.bell!.h).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('button', { name: /^Notifications/ })).toBeVisible();
    // Your avatar is the rail's; settings are in My space.
    await expect(page.getByRole('button', { name: 'User settings' })).toHaveCount(0);
    // A compact server header, as tall as the conversation's.
    expect(m.head!.h).toBeLessThanOrEqual(64);
    await page.locator('.channel-item', { hasText: 'dev' }).click();
    const chatHead = (await page.locator('.chat-header').boundingBox())!;
    expect(chatHead.y).toBe(0);
    expect(Math.abs(chatHead.height - m.head!.h)).toBeLessThanOrEqual(0.5);
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await expect(shell(page)).toHaveClass(/\bphone-home\b/);
    await fits(page);
    await page.screenshot({ path: test.info().outputPath(`home-${phone}.png`) });

    // A channel opens full screen, with a back arrow.
    await page.locator('.channel-item', { hasText: 'dev' }).click();
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    expect((await page.locator('.chat-area').boundingBox())!.width).toBeGreaterThan(w - 2);
    await fits(page);
    await page.screenshot({ path: test.info().outputPath(`chat-${phone}.png`) });
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: /^Members \(/ }).click();
    await expect(shell(page)).toHaveClass(/\bphone-members\b/);
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await page.getByRole('button', { name: 'Back to channels' }).click();

    // MY: Friends and Calls above the direct messages; each full screen.
    await page.getByRole('button', { name: /^You: friends, calls and messages/ }).click();
    const rows = page.locator('.my-sidebar .my-row').getByRole('button');
    // Settings first (the top bar's avatar opened them), then Friends and Calls.
    await expect(rows.nth(0)).toHaveAccessibleName('Settings');
    await expect(rows.nth(1)).toHaveAccessibleName('Friends, 1 request');
    await expect(rows.nth(2)).toHaveAccessibleName('Calls, 1 missed');
    await fits(page);
    await page.screenshot({ path: test.info().outputPath(`my-${phone}.png`) });
    await rows.nth(1).click();
    await expect(page.getByRole('main', { name: 'Friends' })).toBeVisible();
    await expect(shell(page)).toHaveClass(/\bphone-friends\b/);
    await fits(page);
    await page.screenshot({ path: test.info().outputPath(`friends-${phone}.png`) });
    await page.getByRole('button', { name: 'Back to MY' }).click();
    await page.locator('.my-sidebar .my-row').getByRole('button').nth(2).click();
    await expect(page.getByRole('main', { name: 'Calls' })).toBeVisible();
    await fits(page);
    await page.getByRole('button', { name: 'Back to MY' }).click();

    // A DM opens full screen too.
    await page.getByRole('button', { name: /^mox/ }).click();
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    await expect(page.locator('.chat-header')).toContainText('mox');
    await fits(page);
  });

  test(`${phone}: a voice channel's join sheet, the call screen and the minimized bar`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/shots.html?view=chat&voice=rooms&frame=1&platform=ios');
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await page.locator('.channel-sidebar').getByText('General', { exact: true }).click();
    await page.getByRole('button', { name: 'Join call' }).click();
    await expect(page.locator('.mcall')).toBeVisible();
    await expect(shell(page)).toHaveClass(/\bphone-call\b/);
    // A long title (a private call with someone's long nick) never widens it.
    await page.locator('.mcall-title').evaluate((el) => { el.textContent = 'Call with TheLion-windows-desktop-machine'; });
    const fit = await page.evaluate(() => ({ call: document.querySelector('.mcall')!.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth - innerWidth }));
    expect(fit.call).toBeLessThanOrEqual(w);
    expect(fit.scroll).toBeLessThanOrEqual(0);
    await fits(page);
    await page.screenshot({ path: test.info().outputPath(`call-${phone}.png`) });
    await page.getByRole('button', { name: /inimi/ }).first().click();
    await expect(page.locator('.mcall-mini')).toBeVisible();
    const bar = (await page.locator('.mcall-mini').boundingBox())!;
    expect(bar.y + bar.height).toBeGreaterThan(h - 2);
    // Only the minimized bar, not the desktop's voice bar as well.
    await expect(page.locator('.voice-bar')).toHaveCount(0);
  });
}

test.describe('swipes', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  // The drags are CDP touch events: Playwright can only drive them in
  // Chromium (Firefox and WebKit get the same layout specs above).
  test.skip(({ browserName }) => browserName !== 'chromium', 'touch drags need the Chromium DevTools protocol');

  // A one-finger drag, as real touch events (Playwright's touchscreen only taps).
  async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    for (let i = 1; i <= steps; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  test('right for the channels, left for the members, and back', async ({ page }) => {
    await page.goto('/shots.html?view=chat&voice=rooms&friends=1&frame=1&platform=ios');
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    const y = 420;
    // Right: the channel list.
    await drag(page, { x: 40, y }, { x: 340, y });
    await expect(shell(page)).toHaveClass(/\bphone-home\b/);
    // Left on the list: back to the conversation.
    await drag(page, { x: 340, y }, { x: 40, y });
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    // Left: the members; right: the chat again.
    await drag(page, { x: 340, y }, { x: 40, y });
    await expect(shell(page)).toHaveClass(/\bphone-members\b/);
    await drag(page, { x: 40, y }, { x: 340, y });
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    // A short, slow drag springs back; a vertical one scrolls.
    await drag(page, { x: 40, y }, { x: 90, y }, 20);
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    await drag(page, { x: 200, y: 700 }, { x: 220, y: 200 });
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    await fits(page);
  });

  test('mid-swipe, the channel list shows under the conversation', async ({ page }) => {
    await page.goto('/shots.html?view=chat&voice=rooms&friends=1&frame=1&platform=ios');
    await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 30, y: 420 }] });
    for (const x of [50, 90, 140, 200]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 420 }] });
    await expect(page.locator('.phone-layer-under .channel-sidebar')).toBeVisible();
    const cur = (await page.locator('.phone-layer-cur').boundingBox())!;
    expect(cur.x).toBeGreaterThan(100);
    await page.screenshot({ path: test.info().outputPath('swipe-mid-iphone.png') });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await expect(shell(page)).toHaveClass(/\bphone-home\b/);
  });

  // The conversation is always on top: from the channel list and from the
  // members it slides in over them; they stay put underneath.
  for (const [from, start, moves] of [['home', 340, [320, 280, 230, 180]], ['members', 30, [50, 90, 140, 200]]] as const) {
    test(`mid-swipe from ${from}, the conversation slides in on top`, async ({ page }) => {
      await page.goto('/shots.html?view=chat&voice=rooms&friends=1&frame=1&platform=ios');
      await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
      const cdp = await page.context().newCDPSession(page);
      const swipe = async (x0: number, xs: readonly number[], end = true): Promise<void> => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: 420 }] });
        for (const x of xs) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 420 }] });
        if (end) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      // Get to the channel list (right) or the members (left) first.
      if (from === 'home') await swipe(40, [100, 200, 300, 340]);
      else await swipe(340, [280, 200, 100, 40]);
      await expect(shell(page)).toHaveClass(new RegExp(`\\bphone-${from}\\b`));
      await page.waitForTimeout(300);
      await swipe(start, moves, false);
      const top = page.locator('.phone-layer-top');
      await expect(top).toHaveCount(1);
      await expect(top).toHaveClass(/phone-layer-under/);
      await expect(top.locator('.chat-area')).toBeVisible();
      const z = await page.evaluate(() => [...document.querySelectorAll('.phone-layer')].map((e) => ({ top: e.classList.contains('phone-layer-top'), z: Number(getComputedStyle(e).zIndex) || 0, x: e.getBoundingClientRect().x })));
      const t = z.find((l) => l.top)!;
      const other = z.find((l) => !l.top)!;
      expect(t.z).toBeGreaterThan(other.z);
      expect(other.x).toBe(0);
      expect(Math.abs(t.x)).toBeGreaterThan(100);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
      await expect(shell(page)).toHaveClass(/\bphone-chat\b/);
    });
  }
});

// Only phones lose the top bar: a desktop keeps it with the bell, and so
// does a narrow desktop window (it holds the window controls).
for (const [w, h, name] of [[1280, 800, 'desktop'], [339, 734, 'narrow desktop window']] as const) {
  test(`${name} (${w}×${h}): the top bar keeps the bell and your avatar; no bell in the rail`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/shots.html?view=chat&voice=rooms&friends=1&frame=1&memos=1');
    const bar = page.locator('.title-bar');
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: /^Notifications, \d+ unread$/ })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'User settings' })).toBeVisible();
    await expect(page.locator('.rail-bell')).toHaveCount(0);
  });
}
