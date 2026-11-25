// A channel that joins late (refused until NickServ identified us) shows up
// in its usual place in the channel list, not at the end.
import { expect, test } from '@playwright/test';

test('a late-joined channel takes its saved place in the list', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/shots.html?view=chat&late=1');
  const names = () => page.locator('.channel-sidebar .channel-list .channel-item').evaluateAll(
    (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter((t) => /^#?\s*(members|dev|ops)\b/.test(t)).map((t) => t.match(/(members|dev|ops)/)![1]),
  );
  // Before #members gets in: the other two.
  await expect.poll(names).toEqual(['dev', 'ops']);
  // After: first, where the saved list has it.
  await expect.poll(names, { timeout: 5000 }).toEqual(['members', 'dev', 'ops']);
  await page.screenshot({ path: test.info().outputPath('late-join.png') });
});
