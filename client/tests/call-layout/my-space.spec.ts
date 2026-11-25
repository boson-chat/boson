// MY (your avatar at the top of the rail): Friends and Calls above your
// direct messages, the SERVERS divider under it, and the Calls page.
import { expect, test } from '@playwright/test';

const BASE = '/shots.html?view=chat&voice=rooms&friends=1&missed=2';

test('desktop (1440×900): MY is your avatar with a dot, then SERVERS, then the servers', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE);
  const my = page.getByRole('button', { name: /^You: friends, calls and messages/ });
  await expect(my).toBeVisible();
  const m = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const tile = r('.my-tile');
    return { tile, dot: r('.my-tile-dot'), divider: r('.rail-divider'), firstServer: r('.server-rail .server-item'), label: document.querySelector('.rail-divider-label')!.textContent };
  });
  // No second square tile that looks like a server: the avatar is first, then the divider.
  expect(m.label).toBe('SERVERS');
  expect(m.divider.y).toBeGreaterThan(m.tile.y + m.tile.height - 1);
  expect(m.firstServer.y).toBeGreaterThan(m.divider.y + m.divider.height - 1);
  // The presence dot sits on the avatar's bottom-right corner.
  expect(m.dot.x + m.dot.width).toBeGreaterThan(m.tile.x + m.tile.width - 4);
  expect(m.dot.y + m.dot.height).toBeGreaterThan(m.tile.y + m.tile.height - 4);
  await expect(page.locator('.my-tile-badge')).toHaveText('3');

  await my.click();
  const rows = page.locator('.my-sidebar .my-row').getByRole('button');
  await expect(rows.nth(0)).toHaveAccessibleName('Friends, 1 request');
  await expect(rows.nth(1)).toHaveAccessibleName('Calls, 2 missed');
  // Direct messages: people only (the NickServ conversation stays out),
  // newest received first: kestrel wrote 4 minutes ago, mox 20.
  await expect(page.locator('.my-sidebar')).not.toContainText('NickServ');
  const titles = await page.locator('.my-sidebar .my-row .bds-row-title').allInnerTexts();
  expect(titles.filter((t) => !/^(Friends|Calls|Settings)$/.test(t.trim())).map((t) => t.trim())).toEqual(['kestrel', 'mox']);
  await expect(page.getByRole('main', { name: 'Friends' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('my-friends-1440.png') });

  await page.getByRole('button', { name: /^Calls/ }).click();
  await expect(page.getByRole('main', { name: 'Calls' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join General on Nebula' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Call kestrel back' })).toBeVisible();
  await expect(page.locator('.my-tile-badge')).toHaveText('1');
  await page.screenshot({ path: test.info().outputPath('my-calls-1440.png') });

  // A direct message opens in MY's main column, highlighted in its list.
  await page.getByRole('button', { name: /^mox/ }).click();
  await expect(page.locator('.chat-header')).toContainText('mox');
  await expect(page.getByRole('button', { name: /^mox/ })).toHaveAttribute('aria-current', 'page');

  // Join on a live voice channel: back to its server, on its join view.
  await page.getByRole('button', { name: /^Calls/ }).click();
  await page.getByRole('button', { name: 'Join General on Nebula' }).click();
  await expect(page.getByRole('button', { name: 'Join call' })).toBeVisible();
  await expect(page.locator('.my-sidebar')).toHaveCount(0);
});

for (const [w, h, phone] of [[390, 844, 'iphone'], [360, 800, 'android']] as const) {
  test(`phone ${phone} (${w}×${h}): the Calls page lists live channels and missed calls`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${BASE}&tab=calls`);
    await expect(page.getByRole('main', { name: 'Calls' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Call kestrel back' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Design system: 44px buttons on phones; no circles but status dots.
    const shapes = await page.evaluate(() => {
      const main = document.querySelector('main.calls-view')!;
      const small = [...main.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().height < 43.5).map((b) => b.textContent || b.getAttribute('aria-label'));
      const round = [...main.querySelectorAll('*')].filter((e) => !e.classList.contains('bds-dot') && getComputedStyle(e).borderRadius === '50%').map((e) => e.className);
      return { small, round };
    });
    expect(shapes).toEqual({ small: [], round: [] });
    await page.screenshot({ path: test.info().outputPath(`calls-${phone}.png`) });
  });
}
