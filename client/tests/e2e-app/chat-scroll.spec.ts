// The windowed message list (message-render.tsx + virtual-list.ts) and the
// memory windows behind it (ChatService + the OlderStore in IndexedDB):
//   - only the rows on screen (plus a margin) are in the DOM;
//   - scrolling up through a long history brings older pages back and the
//     row being read stays where it is while they're prepended (and while
//     images above it load);
//   - back at the bottom, live lines stick to the bottom;
//   - leaving the channel and coming back lands at the bottom, and the
//     history above is still there.
import type { Page } from '@playwright/test';
import { test, expect, randomChannel, webBrowserFixme } from './fixtures';
import { connectGuest, connectPeer, conversation, joinViaUi, memberRow, messages } from './helpers/chat';
import type { IrcPeer } from './irc-peer';

const N = 700;

// The topmost row fully inside the viewport: its text and its distance from
// the viewport's top.
async function topRow(page: Page): Promise<{ text: string; y: number } | null> {
  return page.evaluate(() => {
    const list = document.querySelector('main .chat-messages') as HTMLElement;
    const top = list.getBoundingClientRect().top;
    for (const row of Array.from(list.querySelectorAll('.message-row-text-body'))) {
      // The row's own box (its text moves up when it joins the group of
      // an older line from the same sender, prepended above it).
      const r = (row.closest('.vrow') ?? row).getBoundingClientRect();
      if (r.top >= top) return { text: row.textContent ?? '', y: r.top - top };
    }
    return null;
  });
}

// Where the row with exactly `text` is, from the viewport's top.
async function rowY(page: Page, text: string): Promise<number | null> {
  return page.evaluate((t) => {
    const list = document.querySelector('main .chat-messages') as HTMLElement;
    const row = Array.from(list.querySelectorAll('.message-row-text-body')).find((r) => r.textContent === t);
    return row ? (row.closest('.vrow') ?? row).getBoundingClientRect().top - list.getBoundingClientRect().top : null;
  }, text);
}

const scrollState = (page: Page) => page.evaluate(() => {
  const l = document.querySelector('main .chat-messages') as HTMLElement;
  return { top: l.scrollTop, height: l.scrollHeight, client: l.clientHeight, rows: l.querySelectorAll('.vrow').length };
});

test.describe('long history', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('scroll up through it and back down: windowed, anchored, sticks to the bottom; leave and come back', async ({ launchApp }) => {
    webBrowserFixme('webkit', 'older history pages in only once while scrolling up in WebKit; to fix');
    webBrowserFixme('firefox', 'older history pages in only once while scrolling up in Firefox (Linux CI); to fix');
    test.setTimeout(240_000);
    const ch = randomChannel('scroll');
    const other = randomChannel('other');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, other, nick);
    await joinViaUi(page, ch, nick);
    await peer.join(ch);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    for (let i = 0; i < N; i++) {
      const extra = i % 9 === 0 ? ' and a longer line that wraps over a couple of lines in the list, '.repeat(3) : '';
      peer.privmsg(ch, `hist ${i}${extra}`);
    }
    await expect(messages(page).getByText(`hist ${N - 1}`, { exact: true })).toBeVisible({ timeout: 60_000 });

    // Windowed: a few dozen rows in the DOM, not 700.
    const s0 = await scrollState(page);
    expect(s0.rows).toBeLessThan(80);
    expect(s0.top + s0.client).toBeGreaterThanOrEqual(s0.height - 2);

    // Up to the very top, a step at a time; whenever older lines are
    // prepended, the row at the top stays put.
    let prepends = 0;
    for (let step = 0; step < 400; step++) {
      const before = await topRow(page);
      const st = await scrollState(page);
      if (st.top <= 0) {
        if (await messages(page).locator('.chat-load-older-end').count() > 0) break;
        await page.waitForTimeout(500);
        const after = await scrollState(page);
        if (after.height > st.height) {
          prepends++;
          const y = await rowY(page, before!.text);
          expect(y).not.toBeNull();
          expect(Math.abs(y! - before!.y)).toBeLessThanOrEqual(2);
        }
        continue;
      }
      await page.evaluate(() => {
        const l = document.querySelector('main .chat-messages') as HTMLElement;
        l.scrollTop = Math.max(0, l.scrollTop - 600);
      });
      await page.waitForTimeout(30);
    }
    expect(prepends).toBeGreaterThan(2);
    await expect(messages(page).getByText('hist 1', { exact: true })).toBeVisible();
    expect((await scrollState(page)).rows).toBeLessThan(80);

    // Back down to the bottom.
    await page.evaluate(async () => {
      const l = document.querySelector('main .chat-messages') as HTMLElement;
      for (let i = 0; i < 500 && l.scrollTop + l.clientHeight < l.scrollHeight - 2; i++) {
        l.scrollTop += 800;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
    });
    await expect(messages(page).getByText(`hist ${N - 1}`, { exact: true })).toBeVisible();
    // A live line sticks to the bottom.
    peer.privmsg(ch, 'live after scrolling');
    await expect(messages(page).getByText('live after scrolling')).toBeInViewport();
    const s1 = await scrollState(page);
    expect(s1.top + s1.client).toBeGreaterThanOrEqual(s1.height - 2);

    // Leave and come back: at the bottom, the history still above.
    await conversation(page, other).click();
    await expect(messages(page).getByText('live after scrolling')).toHaveCount(0);
    peer.privmsg(ch, 'while away');
    await conversation(page, ch).click();
    await expect(messages(page).getByText('while away')).toBeInViewport();
    await page.evaluate(() => { (document.querySelector('main .chat-messages') as HTMLElement).scrollTop = 0; });
    await expect.poll(async () => (await scrollState(page)).height, { timeout: 10_000 }).toBeGreaterThan(s0.client * 3);
    await page.screenshot({ path: test.info().outputPath('scrolled.png') });
  });
});
