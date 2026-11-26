// Reactions (IRCv3 +draft/react) and deleting your own messages
// (draft/message-redaction), through the screenshot harness's fake server
// (?reactions=1: message-tags, echo-message, event-playback and redaction).
import { expect, test, type Page } from '@playwright/test';

const URL = '/shots.html?view=chat&frame=1&reactions=1';
const row = (page: Page, text: string) => page.locator('main .message-row', { hasText: text });
const chip = (page: Page, text: string, emoji: string) => row(page, text).locator('.reaction-chip', { hasText: emoji });
const OWN = 'cutting the build now';
const MENTION = 'are you around?';

async function open(page: Page, width: number, height: number, extra = ''): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(URL + extra, { waitUntil: 'domcontentloaded' });
  await expect(row(page, OWN)).toBeVisible();
}

test.describe('desktop', () => {
  test('chips aggregate live, early and replayed reactions; ours is highlighted and toggles', async ({ page }) => {
    await open(page, 1280, 800);
    // 👍 ×3 (kestrel, mox, us), 😂 ×1 on the mention.
    await expect(chip(page, MENTION, '👍')).toContainText('3');
    await expect(chip(page, MENTION, '👍')).toHaveClass(/reaction-chip-mine/);
    await expect(chip(page, MENTION, '😂')).toContainText('1');
    // On our own line: 🎉 from pixel (sent before the line loaded) and orbit
    // (replayed by CHATHISTORY), ❤️ from nova.
    await expect(chip(page, OWN, '🎉')).toContainText('2');
    await expect(chip(page, OWN, '❤️')).toContainText('1');
    await page.screenshot({ path: test.info().outputPath('desktop-chips.png') });

    // Who reacted, on hover.
    await chip(page, MENTION, '👍').hover();
    await expect(page.locator('.reaction-who')).toHaveText('kestrel, mox and You reacted with 👍');
    await page.screenshot({ path: test.info().outputPath('desktop-who.png') });

    // Our chip: a click takes it back; again puts it back.
    await chip(page, MENTION, '👍').click();
    await expect(chip(page, MENTION, '👍')).toContainText('2');
    await expect(chip(page, MENTION, '👍')).not.toHaveClass(/reaction-chip-mine/);
    await chip(page, MENTION, '👍').click();
    await expect(chip(page, MENTION, '👍')).toContainText('3');
  });

  test('the hover toolbar opens the picker; more lists every emoji', async ({ page }) => {
    await open(page, 1280, 800);
    const r = row(page, MENTION);
    await r.hover();
    await r.locator('.message-toolbar').getByRole('button', { name: 'Add reaction' }).click();
    const picker = page.getByRole('dialog', { name: 'Add reaction' });
    await expect(picker.locator('.reaction-picker-quick-item')).toHaveCount(6);
    await page.screenshot({ path: test.info().outputPath('desktop-picker.png') });
    await picker.getByRole('button', { name: 'More reactions' }).click();
    await picker.getByRole('textbox', { name: 'Search emoji' }).fill('rocket');
    await page.screenshot({ path: test.info().outputPath('desktop-picker-more.png') });
    await picker.getByRole('button', { name: 'React with 🚀' }).click();
    await expect(picker).toBeHidden();
    await expect(chip(page, MENTION, '🚀')).toHaveClass(/reaction-chip-mine/);
    await expect(chip(page, MENTION, '🚀')).toContainText('1');
  });

  test('Delete on our own line only: confirm, then the deleted placeholder', async ({ page }) => {
    await open(page, 1280, 800);
    await row(page, MENTION).hover();
    await expect(row(page, MENTION).getByRole('button', { name: 'Delete message' })).toHaveCount(0);
    await row(page, OWN).hover();
    await row(page, OWN).getByRole('button', { name: 'Delete message' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete message?' });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('desktop-delete-confirm.png') });
    await dialog.getByRole('button', { name: 'Delete' }).click();
    const gone = page.locator('main .message-row', { has: page.locator('.message-deleted') });
    await expect(gone).toHaveCount(1);
    await expect(gone).toContainText('Message deleted');
    await expect(page.locator('main')).not.toContainText(OWN);
    await expect(gone.locator('.reaction-chip')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('desktop-deleted.png') });
  });

  test('a refused delete says so', async ({ page }) => {
    await open(page, 1280, 800, '&redactfail=1');
    await row(page, OWN).hover();
    await row(page, OWN).getByRole('button', { name: 'Delete message' }).click();
    await page.getByRole('dialog', { name: 'Delete message?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText("You can't delete that message.")).toBeVisible();
    await expect(row(page, OWN)).toBeVisible();
  });

  test('without draft/message-redaction there is no Delete', async ({ page }) => {
    await open(page, 1280, 800, '&redact=0');
    await row(page, OWN).hover();
    await expect(row(page, OWN).locator('.message-toolbar').getByRole('button', { name: 'Add reaction' })).toBeVisible();
    await expect(row(page, OWN).getByRole('button', { name: 'Delete message' })).toHaveCount(0);
    await row(page, OWN).click({ button: 'right', position: { x: 300, y: 10 } });
    await expect(page.getByRole('menuitem', { name: 'Add reaction' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete message' })).toHaveCount(0);
  });

  test('without message-tags: no reactions at all', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/shots.html?view=chat&frame=1', { waitUntil: 'domcontentloaded' });
    const r = row(page, MENTION);
    await r.hover();
    await expect(r.getByRole('button', { name: 'Reply' })).toBeVisible();
    await expect(r.getByRole('button', { name: 'Add reaction' })).toHaveCount(0);
  });
});

test.describe('phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('long press: react from the sheet, who reacted, delete with confirm', async ({ page }) => {
    await open(page, 390, 844, '&platform=ios');
    await row(page, OWN).scrollIntoViewIfNeeded();
    await expect(chip(page, OWN, '🎉')).toContainText('2');
    await page.screenshot({ path: test.info().outputPath('phone-chips.png') });

    // Long press on a chip: who reacted.
    await longPress(page, chip(page, OWN, '🎉'));
    await expect(page.locator('.reaction-who')).toHaveText('pixel and orbit reacted with 🎉');
    await page.screenshot({ path: test.info().outputPath('phone-who.png') });
    await page.getByRole('button', { name: 'Back to channels' }).dispatchEvent('touchstart', { touches: [], changedTouches: [] });
    await expect(page.locator('.reaction-who')).toHaveCount(0);

    // Long press on the message: the sheet has Add reaction and Delete.
    await longPress(page, row(page, OWN).locator('.message-row-text'));
    await page.screenshot({ path: test.info().outputPath('phone-sheet.png') });
    await page.getByRole('menuitem', { name: 'Add reaction' }).click();
    const picker = page.getByRole('dialog', { name: 'Add reaction' });
    await expect(picker).toBeVisible();
    await page.waitForTimeout(500); // the sheet has slid away
    await page.screenshot({ path: test.info().outputPath('phone-picker.png') });
    await picker.getByRole('button', { name: 'React with 😮' }).tap();
    await expect(chip(page, OWN, '😮')).toHaveClass(/reaction-chip-mine/);

    await longPress(page, row(page, OWN).locator('.message-row-text'));
    await page.getByRole('menuitem', { name: 'Delete message' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete message?' })).toBeVisible();
    await page.waitForTimeout(500); // the sheet has slid away
    await page.screenshot({ path: test.info().outputPath('phone-delete-confirm.png') });
    await page.getByRole('dialog', { name: 'Delete message?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('main .message-deleted')).toHaveCount(1);
    await page.waitForTimeout(500); // the sheet has slid away
    await page.screenshot({ path: test.info().outputPath('phone-deleted.png') });
  });
});

// A finger held on `el` (useLongPress fires at 450 ms).
async function longPress(page: Page, el: ReturnType<Page['locator']>): Promise<void> {
  const box = (await el.boundingBox())!;
  const x = box.x + Math.min(20, box.width / 2);
  const y = box.y + box.height / 2;
  await el.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: x, clientY: y }], changedTouches: [{ identifier: 1, clientX: x, clientY: y }] });
  await page.waitForTimeout(600);
  await el.dispatchEvent('touchend', { touches: [], changedTouches: [{ identifier: 1, clientX: x, clientY: y }] });
}
