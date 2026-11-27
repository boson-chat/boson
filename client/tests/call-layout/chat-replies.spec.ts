// Replies classic IRC clients can read too (modules/chat/replies.ts).
//
// ?replies=tags&search=1: a server with message-tags and CHATHISTORY:
// replies carry the IRCv3 tag and the text form; one answers a line older
// than what's loaded (fetched on its own, a click loads back to it), one a
// line the server doesn't have. ?replies=plain: no message-tags (ngircd):
// replies are only their text, read back by it.
import { expect, test, type Page } from '@playwright/test';

const list = (page: Page) => page.locator('main .chat-messages');
// The row whose own text (not a quote of it) has `text`.
const rowWith = (page: Page, text: string) =>
  list(page).locator('.vrow').filter({ has: page.locator('.message-row-text-body', { hasText: text }) });
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent?: Array<{ body: string; tags?: Record<string, string> }> }).__sent ?? []);

async function open(page: Page, query: string, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`/shots.html?view=chat&frame=1&${query}`, { waitUntil: 'domcontentloaded' });
  await expect(rowWith(page, 'anyone around?')).toBeVisible();
  await page.waitForTimeout(700);
  await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
}

// Reply to a line: the desktop's hover toolbar.
async function replyTo(page: Page, text: string): Promise<void> {
  const row = rowWith(page, text).locator('.message-row');
  await row.hover();
  await row.getByRole('button', { name: 'Reply', exact: true }).click();
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator('.chat-textarea');
  await box.fill(text);
  await box.press('Enter');
}

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 760 }]) {
  test.describe(`replies (${vp.name})`, () => {
    test('with message-tags: quotes, a plain `nick:` line, a mention, fetched and missing originals', async ({ page }) => {
      await open(page, 'replies=tags&search=1', vp.width, vp.height);
      // A tagged reply: the quote above it, the `mox: "anyone know..." ` gone from its text.
      const k = rowWith(page, 'libssl-dev');
      await expect(k.locator('.message-reply-quote')).toContainText('anyone know why the build fails on arm?');
      await expect(k.locator('.message-row-text-body')).toHaveText("it's libssl-dev, the arm image lacks it");
      // `mox: here` from a classic client: not a reply, just a line (no guessing).
      await expect(rowWith(page, 'mox: here').locator('.message-reply-quote')).toHaveCount(0);
      // A reply to your line, without your nick: a mention.
      await expect(rowWith(page, 'shipping it tonight').locator('.message-row')).toHaveClass(/message-row-mention/);
      // The original isn't loaded: fetched on its own (CHATHISTORY AROUND).
      const n = rowWith(page, 'still true today');
      await expect(n.locator('button.message-reply-quote')).toBeVisible();
      const original = (await n.locator('.message-reply-quote-text').textContent())!;
      // The server doesn't have it.
      await expect(rowWith(page, 'never the plan').locator('.message-reply-quote')).toHaveText('Original message not available');
      await page.screenshot({ path: test.info().outputPath('tags.png') });

      // A click loads back to the original, scrolls to it and flashes it.
      await n.locator('button.message-reply-quote').click();
      const flashed = list(page).locator('.vrow-flash');
      await expect(flashed).toBeVisible({ timeout: 15_000 });
      await expect(flashed).toContainText(original.slice(0, 20));
      const box = (await list(page).boundingBox())!;
      const r = (await flashed.boundingBox())!;
      expect(r.y).toBeGreaterThanOrEqual(box.y - 1);
      expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height + 1);
      await page.waitForTimeout(250);
      await page.screenshot({ path: test.info().outputPath('jumped.png') });
    });

    test('without message-tags (ngircd): Reply opens the bar and sends the text form', async ({ page }) => {
      await open(page, 'replies=plain', vp.width, vp.height);
      // A text-only reply with a quote reads as a real reply.
      const k = rowWith(page, 'libssl-dev');
      await expect(k.locator('.message-reply-quote')).toContainText('anyone know why the build fails on arm?');
      await expect(k.locator('.message-reply-quote-guessed')).toHaveCount(0);
      await expect(k.locator('.message-row-text-body')).toHaveText("it's libssl-dev, the arm image lacks it");
      if (vp.name === 'desktop') {
        await replyTo(page, 'anyone know why the build fails on arm?');
      } else {
        // Phones: long press, then Reply in the sheet.
        const row = rowWith(page, 'anyone know why the build fails on arm?').locator('.message-row');
        await row.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: 40, clientY: 10 }] });
        await page.waitForTimeout(650);
        await row.dispatchEvent('touchend', {});
        await page.getByRole('menuitem', { name: 'Reply' }).click();
      }
      const bar = page.locator('.chat-reply-bar');
      await expect(bar).toContainText('Replying to mox');
      await expect(page.getByRole('menuitem')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('plain-composer.png') });
      await send(page, 'thanks, installing it');
      await expect(bar).toHaveCount(0);
      const out = await sent(page);
      expect(out.at(-1)).toEqual({ target: '#dev', body: 'mox: "anyone know..." thanks, installing it' });
      // Our own copy reads as a reply too.
      const mine = rowWith(page, 'thanks, installing it');
      await expect(mine.locator('.message-reply-quote')).toContainText('anyone know why');
      await expect(mine.locator('.message-row-text-body')).toHaveText('thanks, installing it');
      // The latest line is quoted too, so classic clients can tell.
      if (vp.name === 'desktop') {
        await replyTo(page, 'anyone around?');
        await send(page, 'yep');
        expect((await sent(page)).at(-1)!.body).toBe('mox: "anyone around..." yep');
      }
      await expect(page.getByRole('menuitem')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('plain-sent.png') });
    });

    test('a bare `nick:` is just a line, even with an old "guessed replies" setting saved', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('boson:chat-display:v1', '{"guessedReplies":true}'));
      await open(page, 'replies=plain', vp.width, vp.height);
      await expect(rowWith(page, 'mox: here').locator('.message-reply-quote')).toHaveCount(0);
      await expect(rowWith(page, 'libssl-dev').locator('.message-reply-quote')).toHaveCount(1);
    });
  });
}

test('with message-tags: a sent reply carries the tag and the text', async ({ page }) => {
  await open(page, 'replies=tags&search=1', 1280, 800);
  await replyTo(page, 'also is the standup at 3 or 4?');
  await send(page, '4pm');
  expect((await sent(page)).at(-1)).toEqual({ target: '#dev', body: 'mox: "also..." 4pm', tags: { '+draft/reply': 'r-b2' } });
});
