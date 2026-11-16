// Scrolling back through history on a phone (the mobile project: an
// iPhone's viewport, with touch). Older lines come in as the user flicks
// up to the top of the conversation, or taps "Load older messages", from
// both places they live:
//   - the server's history (IRCv3 CHATHISTORY, which the e2e ergo doesn't
//     offer: a proxy in front of it adds it, helpers/history-proxy.ts);
//   - lines the app trimmed off a long conversation into its older store
//     (IndexedDB), brought back a page at a time.
// The row being read stays where it is while a page lands above it.
//
// The e2e app runs in Chromium: this drives touch scrolling (flings) and
// taps, not WebKit's rubber-band bounce, which is checked by hand on iOS.
import type { CDPSession, Page } from '@playwright/test';
import { test, expect, randomChannel, joinChannel } from './fixtures';
import { connectGuest, connectPeer, messages } from './helpers/chat';
import { startHistoryProxy, type HistoryProxy } from './helpers/history-proxy';
import type { IrcPeer } from './irc-peer';

const list = (page: Page) => page.locator('main .chat-messages');
const ribbon = (page: Page) => list(page).locator('.chat-load-older');
const beginning = (page: Page) => ribbon(page).getByText('Beginning of history');

// A finger flicking the message list down (scrolling back up the history):
// raw touch events, so the browser scrolls (and flings) as on a phone.
async function flickUp(page: Page, cdp: CDPSession): Promise<void> {
  const box = (await list(page).boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  const from = Math.round(box.y + box.height * 0.2);
  const to = Math.round(box.y + box.height * 0.85);
  const steps = 6;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(from + ((to - from) * i) / steps) }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// Flick up until the start of the history shows (or give up).
async function flickToTheStart(page: Page, cdp: CDPSession, maxFlicks = 120): Promise<number> {
  let flicks = 0;
  const trail: number[] = [];
  while (flicks < maxFlicks && (await beginning(page).count()) === 0) {
    await flickUp(page, cdp);
    flicks++;
    await page.waitForTimeout(150);
    trail.push(await list(page).evaluate((l) => Math.round(l.scrollTop)));
  }
  // (Where the list was after each flick, for a failure's report.)
  test.info().annotations.push({ type: 'scrollTop after each flick', description: trail.join(' ') });
  return flicks;
}

// The topmost row fully on screen: its text and distance from the list's top.
async function topRow(page: Page): Promise<{ text: string; y: number } | null> {
  return page.evaluate(() => {
    const l = document.querySelector('main .chat-messages') as HTMLElement;
    const top = l.getBoundingClientRect().top;
    for (const row of Array.from(l.querySelectorAll('.message-row-text-body'))) {
      const r = (row.closest('.vrow') ?? row).getBoundingClientRect();
      if (r.top >= top) return { text: row.textContent ?? '', y: r.top - top };
    }
    return null;
  });
}

async function rowY(page: Page, text: string): Promise<number | null> {
  return page.evaluate((t) => {
    const l = document.querySelector('main .chat-messages') as HTMLElement;
    const row = Array.from(l.querySelectorAll('.message-row-text-body')).find((r) => r.textContent === t);
    return row ? (row.closest('.vrow') ?? row).getBoundingClientRect().top - l.getBoundingClientRect().top : null;
  }, text);
}

// Join, and wait for the chat to have slid back over the drawers.
async function openChannel(page: Page, ch: string): Promise<void> {
  await joinChannel(page, ch);
  await expect(page.locator('.app-shell')).toHaveClass(/\bdrawer-none\b/);
  await expect.poll(async () => (await page.locator('.mobile-main').boundingBox())!.x).toBeLessThan(1);
}

const history = (n: number) => {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({ time: now - (n - i) * 60_000, from: 'histbot', text: `old ${i}` }));
};

test.describe('phone: older messages', () => {
  let proxy: HistoryProxy | null = null;
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await proxy?.close();
    proxy = null;
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('flicking up pages back through the server history (CHATHISTORY) to its start', async ({ launchApp }) => {
    test.setTimeout(180_000);
    proxy = await startHistoryProxy();
    const ch = randomChannel('phist');
    proxy.setHistory(ch, history(260));
    const { page } = await connectGuest(launchApp, { port: proxy.port });
    await openChannel(page, ch);
    const line = (i: number) => messages(page).getByText(`old ${i}`, { exact: true });
    await expect(line(259)).toBeVisible({ timeout: 30_000 });
    await expect(line(0)).toHaveCount(0);

    const cdp = await page.context().newCDPSession(page);
    const flicks = await flickToTheStart(page, cdp);
    await cdp.detach();
    expect(flicks).toBeGreaterThan(0);
    await expect(beginning(page)).toBeVisible();
    await expect(line(0)).toBeVisible();
    const befores = proxy.requests.filter((r) => / BEFORE /.test(r));
    // 260 lines, 50 a page: the latest page, then BEFORE until a short one.
    expect(befores.length).toBeGreaterThanOrEqual(4);
    // Each page asked for what's older than the oldest line shown, once.
    expect(new Set(befores).size).toBe(befores.length);
  });

  test('the ribbon\'s button works with a tap, and the row being read stays in place', async ({ launchApp }) => {
    test.setTimeout(180_000);
    proxy = await startHistoryProxy();
    const ch = randomChannel('ptap');
    proxy.setHistory(ch, history(160));
    const { page } = await connectGuest(launchApp, { port: proxy.port });
    await openChannel(page, ch);
    await expect(messages(page).getByText('old 159', { exact: true })).toBeVisible({ timeout: 30_000 });

    // The server goes quiet: the pull from reaching the top times out, and
    // the ribbon offers a retry (nothing pulls on its own then: only a tap).
    proxy.stallBefore = true;
    const cdp = await page.context().newCDPSession(page);
    for (let n = 0; n < 20 && !proxy.requests.some((r) => / BEFORE /.test(r)); n++) {
      await flickUp(page, cdp);
      await page.waitForTimeout(150);
    }
    await cdp.detach();
    const retry = ribbon(page).getByRole('button', { name: /No response from server — retry/ });
    await expect(retry).toBeVisible({ timeout: 20_000 });
    const asked = proxy.requests.length;
    proxy.stallBefore = false;

    await page.waitForTimeout(300);
    const before = await topRow(page);
    expect(before).not.toBeNull();
    await retry.tap();
    await expect.poll(() => proxy!.requests.length).toBeGreaterThan(asked);
    await expect(messages(page).getByText('old 109', { exact: true })).toHaveCount(1);
    // (Windowed: only the page's newest rows, just above, are in the DOM.)
    // The page landed above: what was at the top of the screen still is.
    await page.waitForTimeout(300);
    const y = await rowY(page, before!.text);
    expect(y).not.toBeNull();
    expect(Math.abs(y! - before!.y)).toBeLessThanOrEqual(2);
  });

  test('flicking up brings back lines trimmed into the older store', async ({ launchApp }) => {
    test.setTimeout(240_000);
    const N = 500;
    const ch = randomChannel('pstore');
    const peer = await connectPeer();
    peers.push(peer);
    const { page } = await connectGuest(launchApp);
    await openChannel(page, ch);
    await peer.join(ch);
    for (let i = 0; i < N; i++) peer.privmsg(ch, `kept ${i}`);
    const line = (i: number) => messages(page).getByText(`kept ${i}`, { exact: true });
    await expect(line(N - 1)).toBeVisible({ timeout: 60_000 });
    // Only a window of it is in memory; the rest waits in the store.
    await expect(line(0)).toHaveCount(0);

    const cdp = await page.context().newCDPSession(page);
    await flickToTheStart(page, cdp);
    await cdp.detach();
    await expect(beginning(page)).toBeVisible();
    await expect(line(0)).toBeVisible();
  });
});
