// Read markers: what was said while the app was closed shows as unread when
// it's opened again (the backlog that comes in is compared with how far the
// user had read), and with IRCv3 draft/read-marker the server's marker wins,
// so a channel read on another client isn't flagged here, and is cleared
// here when it's read there.
//
// The e2e ergo has history off: a proxy in front of it (helpers/history-
// proxy) answers CHATHISTORY from a scripted backlog and, for the second
// test, plays a server with draft/read-marker.
import { test, expect, randomChannel } from './fixtures';
import { connectGuest, conversation, joinViaUi, messages } from './helpers/chat';
import { startHistoryProxy, type HistoryProxy, type HistoryLine } from './helpers/history-proxy';

const MIN = 60_000;

test.describe('read markers', () => {
  let proxy: HistoryProxy | null = null;
  test.afterEach(async () => {
    await proxy?.close();
    proxy = null;
  });

  // Read `ch` (its backlog, `seen`), then move on to `other` and close the app.
  async function readThenClose(launchApp: Parameters<typeof connectGuest>[0], p: HistoryProxy, ch: string, other: string) {
    const first = await connectGuest(launchApp, { port: p.port });
    await joinViaUi(first.page, ch, first.nick);
    await expect(messages(first.page).getByText('read before closing')).toBeVisible({ timeout: 30_000 });
    await joinViaUi(first.page, other, first.nick);
    await expect(conversation(first.page, ch)).not.toHaveClass(/channel-item-unread/);
    // MARKREAD goes out a second after reading (debounced).
    if (p.markreads) await first.page.waitForTimeout(1500);
    await first.app.close();
  }

  test('lines that arrived while the app was closed are unread when it reopens', async ({ launchApp }) => {
    test.setTimeout(180_000);
    proxy = await startHistoryProxy();
    const ch = randomChannel('away');
    const other = randomChannel('here');
    const now = Date.now();
    const seen: HistoryLine[] = [
      { time: now - 60 * MIN, from: 'alice', text: 'an old line' },
      { time: now - 50 * MIN, from: 'bob', text: 'read before closing' },
    ];
    proxy.setHistory(ch, seen);
    await readThenClose(launchApp, proxy, ch, other);

    // While it was closed: two lines, one naming nobody, one from a third.
    proxy.setHistory(ch, [
      ...seen,
      { time: now - 2 * MIN, from: 'alice', text: 'missed one' },
      { time: now - 1 * MIN, from: 'carol', text: 'missed two' },
    ]);
    const second = await launchApp();
    const page = second.page;
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    const row = conversation(page, ch);
    await expect(row.getByLabel(`2 unread messages in ${ch}`)).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveClass(/channel-item-unread/);
    await page.screenshot({ path: test.info().outputPath('unread-after-reopen.png') });

    // Opening it reads it.
    await row.click();
    await expect(messages(page).getByText('missed two')).toBeVisible();
    await conversation(page, other).click();
    await expect(row).not.toHaveClass(/channel-item-unread/);
  });

  test('with draft/read-marker: the server marker wins, is kept up to date, and clears the badge', async ({ launchApp }) => {
    test.setTimeout(180_000);
    proxy = await startHistoryProxy({ readMarker: true });
    const ch = randomChannel('synced');
    const other = randomChannel('here');
    const now = Date.now();
    const seen: HistoryLine[] = [
      { time: now - 60 * MIN, from: 'alice', text: 'an old line' },
      { time: now - 50 * MIN, from: 'bob', text: 'read before closing' },
    ];
    proxy.setHistory(ch, seen);
    await readThenClose(launchApp, proxy, ch, other);
    // The app told the server how far it read.
    expect(proxy.marker(ch)).toBe(new Date(now - 50 * MIN).toISOString());
    expect(proxy.markreads.some((l) => l.startsWith(`MARKREAD ${ch.toLowerCase()} timestamp=`))).toBe(true);

    // Three lines while closed; another client of the account read the first.
    const missed: HistoryLine[] = [
      { time: now - 3 * MIN, from: 'alice', text: 'read on the phone' },
      { time: now - 2 * MIN, from: 'alice', text: 'missed one' },
      { time: now - 1 * MIN, from: 'carol', text: 'missed two' },
    ];
    proxy.setHistory(ch, [...seen, ...missed]);
    proxy.setMarker(ch, missed[0]!.time);
    const second = await launchApp();
    const page = second.page;
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    const row = conversation(page, ch);
    await expect(row.getByLabel(`2 unread messages in ${ch}`)).toBeVisible({ timeout: 30_000 });

    // Read the rest on the other client: the badge goes here too.
    proxy.pushMarker(ch, missed[2]!.time);
    await expect(row).not.toHaveClass(/channel-item-unread/);
    await expect(row.getByLabel(/unread message/)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('read-elsewhere.png') });
  });
});
