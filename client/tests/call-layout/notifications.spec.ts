// Notifications (Notify.dc.html, MobileC.dc.html): toasts for things
// somewhere you're not looking (desktop: stacked top right; phones: a banner
// from the top), incoming calls as a banner or full screen, and the bell.
import { expect, test, type Page } from '@playwright/test';

const BASE = '/shots.html?view=chat&voice=rooms&friends=1&frame=1';
const SIZES = [[1440, 900, 'desktop'], [390, 844, 'iphone'], [360, 800, 'android']] as const;
const platform = (name: string) => (name === 'iphone' ? '&platform=ios' : name === 'android' ? '&platform=android' : '');

async function fits(page: Page): Promise<void> {
  await page.waitForTimeout(350); // (after the slide in)
  const m = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth - innerWidth,
    widest: Math.max(...[...document.querySelectorAll('.ntoast, .notes, .fcall, .pcall, .title-bar')].map((e) => e.getBoundingClientRect().right)),
    vw: innerWidth,
  }));
  expect(m.scroll).toBeLessThanOrEqual(0);
  expect(m.widest).toBeLessThanOrEqual(m.vw + 0.5);
}
async function incoming(page: Page, style: 'full' | 'banner'): Promise<void> {
  await page.addInitScript((s) => localStorage.setItem('boson:notifications:v1', JSON.stringify({ incomingCalls: s })), style);
}

for (const [w, h, name] of SIZES) {
  const phone = name !== 'desktop';
  test.describe(`${name} (${w}×${h})`, () => {
    test.use({ viewport: { width: w, height: h } });

    test('toasts: a mention, a DM and a friend request; no coloured edge', async ({ page }) => {
      await page.goto(`${BASE}${platform(name)}&notify=mention,dm,friend`);
      const toasts = page.locator('.ntoast');
      if (phone) {
        // Phones: one banner from the top at a time, the newest.
        await expect(toasts).toHaveCount(1);
        const b = (await toasts.first().boundingBox())!;
        expect(b.y).toBeLessThan(40);
        expect(b.width).toBeGreaterThan(w - 20);
      } else {
        await expect(toasts).toHaveCount(3);
        const b = (await toasts.first().boundingBox())!;
        expect(b.x + b.width).toBeGreaterThan(w - 20);
        await expect(page.getByRole('button', { name: "Accept juno's friend request" })).toBeVisible();
        await expect(page.getByRole('button', { name: "Ignore juno's friend request" })).toBeVisible();
      }
      const edge = await toasts.first().evaluate((e) => getComputedStyle(e).borderLeftWidth);
      expect(edge).toBe('1px');
      await fits(page);
      await page.screenshot({ path: test.info().outputPath(`toasts-${name}.png`) });
    });

    test('calls: missed (Call back / Dismiss) and started (Join / Dismiss)', async ({ page }) => {
      await page.goto(`${BASE}${platform(name)}&notify=started,missed`);
      await expect(page.getByRole('button', { name: 'Call kestrel back' })).toBeVisible();
      if (!phone) await expect(page.getByRole('button', { name: 'Join General' })).toBeVisible();
      await fits(page);
      await page.screenshot({ path: test.info().outputPath(`calls-toasts-${name}.png`) });
      if (!phone) {
        await page.getByRole('button', { name: 'Join General' }).click();
        await expect(page.getByRole('button', { name: 'Join call' })).toBeVisible();
      }
    });

    test('an incoming call as a banner: Decline / Voice only / Accept', async ({ page }) => {
      await incoming(page, 'banner');
      await page.goto(`${BASE}${platform(name)}&notify=ring`);
      const ring = page.getByRole('alertdialog', { name: 'kestrel is calling' });
      await expect(ring).toBeVisible();
      await expect(ring).toHaveClass(/ntoast-ring/);
      await expect(ring.getByRole('button', { name: phone ? 'Decline' : 'Decline call' })).toBeVisible();
      await expect(ring.getByRole('button', { name: 'Accept with voice only' })).toBeVisible();
      await expect(ring.getByRole('button', { name: phone ? 'Accept' : 'Accept call', exact: true })).toBeVisible();
      await fits(page);
      await page.screenshot({ path: test.info().outputPath(`ring-banner-${name}.png`) });
      // Tapping the banner opens it full screen.
      await ring.getByRole('button', { name: /Open full screen/ }).click();
      await expect(page.locator(phone ? '.pcall-in' : '.fcall')).toBeVisible();
      await expect(page.locator('.ntoast-ring')).toHaveCount(0);
    });

    test('an incoming call full screen', async ({ page }) => {
      await incoming(page, 'full');
      await page.goto(`${BASE}${platform(name)}&notify=ring`);
      await expect(page.getByRole('alertdialog', { name: 'kestrel is calling' })).toBeVisible();
      await expect(page.locator(phone ? '.pcall-in' : '.fcall')).toBeVisible();
      await expect(page.locator('.ntoast-ring')).toHaveCount(0);
      await fits(page);
      await page.screenshot({ path: test.info().outputPath(`ring-full-${name}.png`) });
    });

    test('the bell: unread first, filters, Mark all read', async ({ page }) => {
      await page.goto(`${BASE}${platform(name)}&notify=mention,dm,friend,missed`);
      await expect(page.locator('.ntoast').first()).toBeVisible();
      await page.getByRole('button', { name: /^Notifications, \d+ unread/ }).click();
      const list = page.getByRole('dialog', { name: 'Notifications' });
      await expect(list).toBeVisible();
      await expect(list.locator('.notes-item')).toHaveCount(4);
      await expect(list.locator('.notes-dot')).toHaveCount(4);
      for (const f of ['All', 'Mentions', 'Messages', 'Friends', 'Calls']) await expect(list.getByRole('tab', { name: new RegExp(`^${f}`) })).toBeVisible();
      // The toasts step aside while the list is open.
      await expect(page.locator('.ntoasts')).toBeHidden();
      await fits(page);
      await page.screenshot({ path: test.info().outputPath(`bell-${name}.png`) });
      await list.getByRole('button', { name: 'Mark all read' }).click();
      await expect(list.locator('.notes-dot')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
    });
  });
}

test('reduced motion: toasts and the ringing banner are still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('boson:notifications:v1', JSON.stringify({ incomingCalls: 'banner' })));
  await page.goto(`${BASE}&notify=ring,dm`);
  await expect(page.locator('.ntoast-ring')).toBeVisible();
  const anims = await page.evaluate(() => [...document.querySelectorAll('.ntoast, .ntoast *')].map((e) => getComputedStyle(e).animationName).filter((n) => n !== 'none'));
  expect(anims).toEqual([]);
});
