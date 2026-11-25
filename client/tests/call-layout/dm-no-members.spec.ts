// A DM, a person's or a service's, has no member list: opening one with the
// members panel shown hides the panel, and it never sits on "Loading members…".
import { expect, test } from '@playwright/test';

test('desktop: the members panel shows for a channel, not for a DM or a service', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/shots.html?view=chat&voice=rooms&friends=1&frame=1');
  const panel = page.locator('aside.user-panel');
  const sidebar = page.locator('aside.channel-sidebar');
  await sidebar.getByText('dev', { exact: true }).click();
  await expect(panel).toBeVisible();
  for (const dm of ['mox', 'NickServ']) {
    await sidebar.getByText(dm, { exact: true }).click();
    await expect(page.locator('.chat-header')).toContainText(dm);
    await expect(panel).toHaveCount(0);
    await expect(page.getByText('Loading members…')).toHaveCount(0);
  }
  await page.screenshot({ path: test.info().outputPath('nickserv-no-members.png') });
  // Back in the channel the panel returns.
  await sidebar.getByText('dev', { exact: true }).click();
  await expect(panel).toBeVisible();
});
