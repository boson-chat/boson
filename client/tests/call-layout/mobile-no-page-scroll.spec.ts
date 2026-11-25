// The app itself never scrolls, only its panes do (the message list, the
// channel list, settings …): on a phone, keyboard up or down, the document
// is exactly the screen, a page scroll is a no-op and nothing is taller than
// what's visible. Chromium can't open a real on-screen keyboard, so it's
// simulated the way iOS shows one: the layout viewport stays, the visual
// viewport (a stand-in for window.visualViewport) shrinks, and
// shared/visual-viewport.ts sizes the app to it.
import { expect, test, type Page } from '@playwright/test';

const BASE = '/shots.html?view=chat&voice=rooms&friends=1&missed=1&frame=1&platform=ios';
// The iPhone 15's screen as the scaled phone layout sees it (390×844 / 1.15),
// and the unscaled one (Android, the mobile web build).
const PHONES = [[339, 734], [390, 844]] as const;
// A touch screen: the app tracks the visual viewport there.
test.use({ hasTouch: true, isMobile: true });

// About an iPhone keyboard (with its suggestions row) at each size.
const KEYBOARD = { 339: 292, 390: 336 } as Record<number, number>;

// A visual viewport the test can shrink: `__kb` px of keyboard, plus a
// fraction of a pixel, as a scaled phone reports (844pt / 1.15 = 733.9px).
async function fakeVisualViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __kb: number; __vv: EventTarget };
    w.__kb = 0;
    const vv = new EventTarget();
    Object.defineProperty(vv, 'height', { get: () => innerHeight - w.__kb + 0.6 });
    Object.defineProperty(vv, 'width', { get: () => innerWidth });
    Object.defineProperty(vv, 'offsetTop', { get: () => 0 });
    Object.defineProperty(vv, 'offsetLeft', { get: () => 0 });
    Object.defineProperty(vv, 'scale', { get: () => 1 });
    w.__vv = vv;
    Object.defineProperty(window, 'visualViewport', { get: () => vv });
  });
}

async function setKeyboard(page: Page, px: number): Promise<void> {
  await page.evaluate((kb) => {
    const w = window as unknown as { __kb: number; __vv: EventTarget };
    w.__kb = kb;
    w.__vv.dispatchEvent(new Event('resize'));
  }, px);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('kb-open'))).toBe(px > 0);
}

// The page can't scroll: the document is no taller than the screen, the app
// ends at the (visual) viewport's bottom, and a page scroll goes nowhere.
async function noPageScroll(page: Page, what: string): Promise<void> {
  const m = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    const vv = window.visualViewport!;
    const app = document.getElementById('app')!.getBoundingClientRect();
    window.scrollTo(0, 100);
    document.body.scrollTop = 100;
    const out = {
      docOver: doc.scrollHeight - doc.clientHeight,
      docOverX: doc.scrollWidth - doc.clientWidth,
      bodyOver: document.body.scrollHeight - document.body.clientHeight,
      appOver: app.bottom - vv.height,
      scrollY: window.scrollY,
      bodyTop: document.body.scrollTop,
    };
    window.scrollTo(0, 0);
    return out;
  });
  expect(m, what).toEqual({ docOver: 0, docOverX: 0, bodyOver: 0, appOver: expect.any(Number), scrollY: 0, bodyTop: 0 });
  expect(m.appOver, `${what}: the app ends above the keyboard`).toBeLessThanOrEqual(0);
}

// Both ways, keyboard down and up.
async function noPageScrollEitherWay(page: Page, kb: number, what: string): Promise<void> {
  await noPageScroll(page, `${what}, keyboard down`);
  await setKeyboard(page, kb);
  await noPageScroll(page, `${what}, keyboard up`);
  await setKeyboard(page, 0);
}

for (const [w, h] of PHONES) {
  test(`${w}×${h}: the document never scrolls, keyboard up or down; the panes still do`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await fakeVisualViewport(page);
    await page.goto(BASE);
    const shell = page.locator('.app-shell');
    const kb = KEYBOARD[w]!;

    // The conversation, typing: the composer sits on the keyboard, the
    // header stays at the top.
    await expect(shell).toHaveClass(/\bphone-chat\b/);
    await noPageScrollEitherWay(page, kb, 'conversation');
    const composer = page.locator('.chat-area textarea').first();
    await composer.click();
    await setKeyboard(page, kb);
    await noPageScroll(page, 'conversation, typing');
    const top = h - kb;
    expect((await page.locator('.chat-header').boundingBox())!.y).toBe(0);
    const c = (await composer.boundingBox())!;
    expect(c.y + c.height).toBeLessThanOrEqual(top);
    expect(c.y + c.height).toBeGreaterThan(top - 80);
    // The message list is its own scroller, and still scrolls.
    const list = page.locator('.chat-messages').first();
    const scrolled = await list.evaluate(async (el) => {
      el.scrollTop = 0;
      const tall = el.scrollHeight > el.clientHeight;
      el.scrollTop = 120;
      return { tall, top: el.scrollTop };
    });
    expect(scrolled.tall).toBe(true);
    expect(scrolled.top).toBeGreaterThan(0);
    await list.hover();
    await page.mouse.wheel(0, 200);
    await noPageScroll(page, 'conversation, after scrolling the messages');
    await setKeyboard(page, 0);
    await composer.blur();

    // Conversation search, typing in its box.
    await page.getByRole('button', { name: /^Search in / }).click();
    const box = page.getByRole('searchbox', { name: 'Search messages' });
    await expect(box).toBeVisible();
    await box.focus();
    await noPageScrollEitherWay(page, kb, 'search');
    await page.getByRole('button', { name: /^Back to #/ }).click();
    await expect(box).toHaveCount(0);

    // The channel list.
    await page.getByRole('button', { name: 'Back to channels' }).click();
    await expect(shell).toHaveClass(/\bphone-home\b/);
    await noPageScrollEitherWay(page, kb, 'channel list');

    // My space, and a page from it.
    await page.getByRole('button', { name: /^You: friends, calls and messages/ }).click();
    const rows = page.locator('.my-sidebar .my-row').getByRole('button');
    await expect(rows.first()).toBeVisible();
    await noPageScrollEitherWay(page, kb, 'My space');
    await rows.nth(1).click();
    await expect(page.getByRole('main', { name: 'Friends' })).toBeVisible();
    await noPageScrollEitherWay(page, kb, 'Friends');
  });
}

// Settings (the harness opens it on its own; in the app it's a row in My
// space): a pane, and a field typed into with the keyboard up.
for (const [w, h] of PHONES) {
  test(`${w}×${h}: settings, typing in a field: the page stays put`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await fakeVisualViewport(page);
    for (const section of ['notifications', 'chat', 'profile']) {
      await page.goto(`/shots.html?view=settings&section=${section}&platform=ios`);
      await expect(page.getByRole('dialog').first()).toBeVisible();
      await noPageScrollEitherWay(page, KEYBOARD[w]!, `settings: ${section}`);
    }
    const field = page.getByRole('dialog').locator('input[type="text"], input:not([type]), textarea').first();
    await field.focus();
    await setKeyboard(page, KEYBOARD[w]!);
    await noPageScroll(page, 'settings, typing');
  });
}
