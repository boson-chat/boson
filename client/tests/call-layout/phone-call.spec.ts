// The phone call screen (MobileCall.tsx), iPhone and Android sizes:
// a 1:1 call has the other person fill the stage and you in the corner;
// more people share a two-column grid. Same component on iOS and Android.
import { expect, test } from '@playwright/test';

const PHONES = [[390, 844, 'iphone'], [360, 800, 'android']] as const;

for (const [w, h, phone] of PHONES) {
  test(`1:1 on ${phone} (${w}×${h}): the other person fills the stage, you're the corner picture`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/shots.html?view=chat&voice=connected&video=call&people=2');
    await page.waitForSelector('.mcall .mcall-grid .mcall-t canvas', { timeout: 20_000 });
    const m = await page.evaluate(() => {
      const r = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return { stage: r('.mcall-stage'), tile: r('.mcall-grid .mcall-t'), pip: r('.mcall-pip'), tiles: document.querySelectorAll('.mcall-grid .mcall-t').length, vw: innerWidth };
    });
    expect(m.tiles).toBe(1);
    // Full width of the stage (its padding aside) and most of its height.
    expect(m.tile.w).toBeGreaterThan(m.stage.w - 24);
    expect(m.tile.h).toBeGreaterThan(m.stage.h * 0.85);
    expect(m.tile.x + m.tile.w).toBeLessThanOrEqual(m.vw);
    // The corner picture is over the remote video, inside it.
    expect(m.pip.x).toBeGreaterThan(m.tile.x);
    expect(m.pip.y + m.pip.h).toBeLessThanOrEqual(m.tile.y + m.tile.h + 1);
    await page.screenshot({ path: test.info().outputPath(`1to1-${phone}.png`) });
  });

  test(`group call on ${phone}: two columns`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/shots.html?view=chat&voice=connected&video=call&people=4');
    await page.waitForSelector('.mcall .mcall-grid .mcall-t canvas', { timeout: 20_000 });
    const widths = await page.evaluate(() => [...document.querySelectorAll('.mcall-grid .mcall-t')].map((e) => e.getBoundingClientRect().width));
    expect(widths.length).toBe(3);
    for (const tw of widths) expect(tw).toBeLessThan(w / 2);
  });
}

test('1:1 with a screen share: the share leads, the grid is as before', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/shots.html?view=chat&voice=connected&video=screen&people=2');
  await page.waitForSelector('.mcall .mcall-screen canvas', { timeout: 20_000 });
  expect(await page.locator('.mcall-grid[data-solo]').count()).toBe(0);
});
