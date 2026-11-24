// The chat chrome (title bar, rail, channel list, chat header, composer,
// members) is drawn with the shared components: no circles or pills except
// status dots and spinners, and on phones every control there is a 44px
// target.
import { expect, test, type Page } from '@playwright/test';

const URL = '/shots.html?view=chat&voice=rooms&friends=1&missed=1&frame=1';
const AREAS = '.title-bar, .server-rail, .channel-sidebar, .chat-area, .user-panel';
// Genuinely round: a status dot, a spinner, the typing dots.
const ROUND_OK = '.bds-dot, .bds-btn-spinner, .channel-sync-spinner, .chat-typing-dot';

async function roundThings(page: Page): Promise<string[]> {
  return page.evaluate(([areas, ok]) => {
    const out: string[] = [];
    for (const area of document.querySelectorAll(areas)) {
      for (const el of [area, ...area.querySelectorAll('*')]) {
        if (el.matches(ok)) continue;
        // The voice section and MY tile belong to the calls / friends migrations.
        if (el.closest('.voice-section, .voice-rooms, .voice-bar, .call-strip, .in-call-strip, .my-tile')) continue;
        const r = getComputedStyle(el).borderTopLeftRadius;
        const box = el.getBoundingClientRect();
        if (!box.width) continue;
        const px = r.endsWith('%') ? (parseFloat(r) / 100) * box.width : parseFloat(r);
        if (px >= Math.min(box.width, box.height) / 2 - 0.5 && px > 6) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${r}`);
      }
    }
    return out;
  }, [AREAS, ROUND_OK] as const);
}

async function smallControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel = '.title-bar button, .rail-bell, .channel-sidebar-header button, .channel-add, .chat-header button, .chat-input-bar button, .user-panel-header button';
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ b, r: b.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.height < 43.5 || r.width < 43.5))
      .map(({ b, r }) => `${b.getAttribute('aria-label') ?? b.textContent} ${r.width}×${r.height}`);
  });
}

test('desktop: no circles or pills in the chat chrome', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(URL);
  await expect(page.locator('.chat-area')).toBeVisible();
  expect(await roundThings(page)).toEqual([]);
});

for (const [w, h, phone] of [[390, 844, 'ios'], [360, 800, 'android']] as const) {
  test(`${phone}: 44px controls and no circles in the chat chrome`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${URL}&platform=${phone}`);
    await expect(page.locator('.chat-area')).toBeVisible();
    expect(await smallControls(page)).toEqual([]);
    expect(await roundThings(page)).toEqual([]);
    await page.getByRole('button', { name: 'Back to channels' }).click();
    expect(await smallControls(page)).toEqual([]);
    expect(await roundThings(page)).toEqual([]);
    await page.locator('.channel-item', { hasText: 'dev' }).click();
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: /^Members \(/ }).click();
    expect(await smallControls(page)).toEqual([]);
    expect(await roundThings(page)).toEqual([]);
  });
}
