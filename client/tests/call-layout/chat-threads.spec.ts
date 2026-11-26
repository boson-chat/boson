// Threads from reply chains (modules/chat/threads.ts, ThreadPanel.tsx).
//
// ?threads=1: a server with message-tags; #dev has a thread with replies to
// replies (one of them yours), a thread with one reply, a guessed `nick:`
// reply (no thread), and a chain whose original isn't loaded.
import { expect, test, type Page } from '@playwright/test';

const list = (page: Page) => page.locator('main .chat-messages');
const rowWith = (page: Page, text: string) =>
  list(page).locator('.vrow').filter({ has: page.locator('.message-row-text-body', { hasText: text }) });
const panel = (page: Page) => page.locator('.thread-panel');
// On a phone: the sheet covers the screen (on it, and on top of it). It
// once sat just below the screen, laid out but out of sight.
async function sheetCovers(page: Page): Promise<void> {
  const vp = page.viewportSize()!;
  // Under the title bar where there is one (a narrow desktop window).
  const top = await page.evaluate(() => document.querySelector('.title-bar')?.getBoundingClientRect().bottom ?? 0);
  // (After its slide-in.)
  await expect.poll(async () => Math.abs((await panel(page).boundingBox())!.y - top)).toBeLessThan(1);
  const box = (await panel(page).boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(vp.height - 2);
  expect(box.y + box.height).toBeLessThan(vp.height + 2);
  expect(box.width).toBeGreaterThan(vp.width - 2);
  // Nothing over it: its back button is what a tap there hits.
  await expect.poll(() => page.evaluate(() => {
    const b = document.querySelector('.thread-panel-back')!.getBoundingClientRect();
    return !!document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('.thread-panel-back');
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => !!document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('.thread-panel'))).toBe(true);
}
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __sent?: Array<{ body: string; tags?: Record<string, string> }> }).__sent ?? []);

async function open(page: Page, width: number, height: number, query = ''): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`/shots.html?view=chat&frame=1&threads=1${query}`, { waitUntil: 'domcontentloaded' });
  await expect(rowWith(page, 'done, green on arm now')).toBeVisible();
  await page.waitForTimeout(600);
}

// The list only renders the rows near the viewport: scroll up from the
// bottom until the row is there, then bring it into view.
async function scrollTo(page: Page, text: string): Promise<void> {
  await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);
  for (let i = 0; i < 40 && (await rowWith(page, text).count()) === 0; i++) {
    await list(page).evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight * 0.6); });
    await page.waitForTimeout(120);
  }
  await rowWith(page, text).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
}

for (const vp of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 760 }]) {
  test.describe(`threads (${vp.name})`, () => {
    test('counter lines under roots; the panel shows the thread and replies into it', async ({ page }) => {
      await open(page, vp.width, vp.height);
      // The root: "4 replies" (a reply to a reply stays in it), faces of who replied.
      await scrollTo(page, 'anyone know why the build fails on arm?');
      const root = rowWith(page, 'anyone know why the build fails on arm?');
      const line = root.locator('.message-thread-line');
      await expect(line).toContainText('5 replies');
      await expect(line).toContainText('last reply just now');
      await expect(line.locator('.message-thread-face')).toHaveCount(3);
      // A reply inside the thread keeps showing in the timeline, with its quote.
      await expect(rowWith(page, 'same on my pi').locator('.message-reply-quote')).toBeVisible();
      await expect(rowWith(page, 'same on my pi').locator('.message-thread-line')).toHaveCount(0);
      // One reply: "1 reply". A guess (`nova: ok`) doesn't count.
      await expect(rowWith(page, 'standup moved to 4pm today').locator('.message-thread-line')).toContainText('1 reply');
      // A chain whose original isn't loaded: rooted at its oldest line.
      await scrollTo(page, 'agreed, and the cert renewed fine');
      await expect(rowWith(page, 'agreed, and the cert renewed fine').locator('.message-thread-line')).toContainText('1 reply');
      await scrollTo(page, 'anyone know why the build fails on arm?');
      await page.screenshot({ path: test.info().outputPath('counter.png') });

      await line.click();
      await expect(panel(page)).toBeVisible();
      const rows = panel(page).locator('.message-row');
      await expect(rows).toHaveCount(6);
      await expect(rows.nth(0)).toContainText('anyone know why the build fails on arm?');
      await expect(rows.nth(5)).toContainText('done, green on arm now');
      await expect(panel(page).locator('.thread-panel-divider')).toHaveText('5 replies');
      // The composer answers the newest line from someone else.
      await expect(panel(page).locator('.chat-reply-bar')).toContainText('Replying to mox');
      if (vp.name === 'desktop') {
        // Beside the conversation, which keeps its width share.
        const box = (await panel(page).boundingBox())!;
        const main = (await page.locator('main.chat-area').boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
        expect(main.width).toBeGreaterThan(400);
      } else {
        // A full-height sheet, on screen.
        await sheetCovers(page);
      }
      await page.screenshot({ path: test.info().outputPath('panel.png') });

      // Send from the panel: a normal reply on the wire (tag + text).
      const box = panel(page).locator('.chat-textarea');
      await box.fill('nice, closing the ticket');
      await page.screenshot({ path: test.info().outputPath('composer.png') });
      if (vp.name === 'phone') await panel(page).getByRole('button', { name: /send/i }).click();
      else await box.press('Enter');
      const out = (await sent(page)).at(-1)!;
      expect(out).toMatchObject({ body: 'mox: nice, closing the ticket', tags: { '+draft/reply': 't-8' } });
      await expect(rows).toHaveCount(7);
      await expect(rows.nth(6)).toContainText('nice, closing the ticket');
      await expect(panel(page).locator('.thread-panel-divider')).toHaveText('6 replies');

      // A live reply to a reply joins too, and the timeline's counter follows.
      await page.evaluate(() => (window as unknown as { __emit: (e: unknown) => void }).__emit({
        Kind: 'PRIVMSG', From: 'kestrel', Target: '#dev', Message: 'mox: "done, green..." great',
        Tags: { time: new Date().toISOString(), msgid: 't-9', '+draft/reply': 't-8' }, Raw: '',
      }));
      await expect(rows).toHaveCount(8);
      await page.screenshot({ path: test.info().outputPath('panel-live.png') });

      if (vp.name === 'desktop') {
        await expect(line).toContainText('7 replies');
        // "Show in conversation" from the panel: scrolled to and flashed.
        const first = rows.nth(2);
        await first.hover();
        await first.getByRole('button', { name: 'Show in conversation' }).click();
        await expect(list(page).locator('.vrow-flash')).toContainText('adding it to the image now');
        // Escape closes it; the member list comes back.
        await panel(page).locator('.thread-panel-close').click();
        await expect(panel(page)).toHaveCount(0);
      } else {
        await panel(page).getByRole('button', { name: 'Close thread' }).click();
        await expect(panel(page)).toHaveCount(0);
        await scrollTo(page, 'anyone know why the build fails on arm?');
        await expect(line).toContainText('7 replies');
      }
    });

    test('"View thread" from a reply\'s menu', async ({ page }) => {
      await open(page, vp.width, vp.height);
      await scrollTo(page, 'adding it to the image now');
      const row = rowWith(page, 'adding it to the image now').locator('.message-row');
      if (vp.name === 'desktop') {
        await row.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'View thread' }).click();
      } else {
        await row.dispatchEvent('touchstart', { touches: [{ identifier: 0, clientX: 40, clientY: 10 }] });
        await page.waitForTimeout(650);
        await row.dispatchEvent('touchend', {});
        await page.getByRole('menuitem', { name: 'View thread' }).click();
      }
      await expect(panel(page).locator('.message-row').first()).toContainText('anyone know why the build fails on arm?');
      if (vp.name === 'phone') await sheetCovers(page);
    });
  });
}

test('reactions and a deleted reply look the same in the panel', async ({ page }) => {
  await open(page, 1280, 800, '&reactions=1');
  await scrollTo(page, 'anyone know why the build fails on arm?');
  const root = rowWith(page, 'anyone know why the build fails on arm?');
  await expect(root.locator('.message-thread-line')).toContainText('5 replies');
  await root.locator('.message-thread-line').click();
  const rows = panel(page).locator('.message-row');
  await expect(rows).toHaveCount(6);
  // The root's reaction chip, in the panel too.
  await expect(rows.nth(0)).toContainText('👍');
  // pixel's deleted reply: still in the thread, as "Message deleted".
  await expect(panel(page)).toContainText(/deleted/i);
  await page.screenshot({ path: test.info().outputPath('reactions.png') });
});

test('dark theme: counter line and panel', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page, 1280, 800);
  await scrollTo(page, 'anyone know why the build fails on arm?');
  await rowWith(page, 'anyone know why the build fails on arm?').locator('.message-thread-line').click();
  await expect(panel(page)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('dark.png') });
});

test('light theme (Daylight): counter line and panel', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('boson:theme:v1', JSON.stringify({ active: 'daylight' })));
  await open(page, 1280, 800);
  await scrollTo(page, 'anyone know why the build fails on arm?');
  const line = rowWith(page, 'anyone know why the build fails on arm?').locator('.message-thread-line');
  await line.hover();
  await page.screenshot({ path: test.info().outputPath('light-hover.png') });
  await line.click();
  await expect(panel(page)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('light.png') });
});

// A phone (touch, no hover): a tap on the counter line opens the thread.
// iOS drops the click of a tap whose :hover shows or hides content (it
// takes the tap as "hover first"), which is how the line once did nothing
// on an iPhone: nothing in it may change on hover where hover is none.
test.describe('threads on a touch screen', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 760 } });

  test('a tap on the counter line opens the sheet; hover changes nothing in it', async ({ page }) => {
    await open(page, 390, 760);
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
    await scrollTo(page, 'standup moved to 4pm today');
    const line = rowWith(page, 'standup moved to 4pm today').locator('.message-thread-line');
    // A real button, "View thread" shown from the start.
    await expect(line).toHaveJSProperty('tagName', 'BUTTON');
    await expect(line).toHaveAttribute('type', 'button');
    await expect(line.locator('.message-thread-view')).toBeVisible();
    const shown = () => line.evaluate((el) => Array.from(el.querySelectorAll('*'))
      .map((c) => { const s = getComputedStyle(c); return `${s.display}/${s.visibility}/${s.opacity}`; }).join(','));
    const before = await shown();
    await line.hover();
    expect(await shown()).toBe(before);
    await page.screenshot({ path: test.info().outputPath('touch-counter.png') });

    await line.tap();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator('.message-row').first()).toContainText('standup moved to 4pm today');
    await sheetCovers(page);
    await page.waitForTimeout(300); // its slide-in
    await page.screenshot({ path: test.info().outputPath('touch-sheet.png') });
    await panel(page).getByRole('button', { name: 'Close thread' }).tap();
    await expect(panel(page)).toHaveCount(0);
  });
});
