// History events (draft/event-playback): a channel's replayed joins and
// quits show as Boson's own collapsed activity rows, at their time, once —
// not as HistServ lines, and not a second time next to the rows Boson made
// when it saw them live.
//
// ?evplay=1: the harness sees juno join and orbit quit live, then #dev's
// history replays those two (and older joins/quits, a nick change, a typing
// TAGMSG) as events, plus HistServ's stand-ins from a server without
// event-playback.
import { expect, test, type Page } from '@playwright/test';

const list = (page: Page) => page.locator('main .chat-messages');

// Every activity line, expanded, as text.
async function activityLines(page: Page): Promise<string[]> {
  const toggles = list(page).locator('.message-activity-toggle[aria-expanded="false"]');
  while (await toggles.count()) await toggles.first().click();
  return list(page).locator('.message-activity-lines > *').allInnerTexts();
}

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 760 }]) {
  test(`${vp.name}: replayed joins and quits collapse into the activity rows, once, with no HistServ`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/shots.html?view=chat&frame=1&evplay=1', { waitUntil: 'domcontentloaded' });
    await expect(list(page).locator('.vrow').first()).toBeVisible();
    await page.waitForTimeout(500);

    await expect(list(page)).not.toContainText('HistServ');
    await expect(list(page)).not.toContainText('joined the channel');
    await expect(list(page)).not.toContainText('sent a TAGMSG');

    // The old joins/quit fold into one summary row, above the conversation.
    const summaries = await list(page).locator('.message-activity-summary').allInnerTexts();
    expect(summaries.some((s) => /mox and pixel popped in/.test(s) && /quasar left/.test(s))).toBe(true);
    await page.screenshot({ path: test.info().outputPath('collapsed.png') });

    const lines = (await activityLines(page)).map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase());
    await page.screenshot({ path: test.info().outputPath('expanded.png') });
    const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
    // Live and replayed copies of the same event: one row each.
    expect(count(/juno joined/)).toBe(1);
    expect(count(/orbit quit/)).toBe(1);
    expect(count(/mox joined/)).toBe(1);
    expect(count(/pixel joined/)).toBe(1);
    expect(count(/quasar quit/)).toBe(1);
  });
}
