import { expect, test } from '@playwright/test';

// The directory and the login screen use the shared components: no pills
// or circles except status dots and spinners.
for (const view of ['directory', 'auth']) {
  test(`${view}: no circles or pills but status dots`, async ({ page }) => {
    await page.goto(`/shots.html?view=${view}`);
    await page.waitForSelector(view === 'directory' ? '.directory-card' : '.login-container');
    const round = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter((e) => {
        if (e.closest('.bds-dot, .bds-btn-spinner, .login-sso-spinner, .bds-toggle, .bds-atom')) return false;
        const r = getComputedStyle(e).borderTopLeftRadius;
        const h = e.getBoundingClientRect().height;
        return r.endsWith('%') || (h > 0 && parseFloat(r) >= h / 2 && parseFloat(r) > 6);
      })
      .map((e) => `${e.tagName}.${(e as HTMLElement).className}`));
    expect(round).toEqual([]);
  });
}
