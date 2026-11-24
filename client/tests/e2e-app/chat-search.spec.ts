// The full-page conversation search on a desktop window, against the e2e
// ergo with ~1200 lines of server history (a CHATHISTORY proxy in front of
// it): Ctrl/Cmd+F opens it in place of the conversation, "Older results"
// pages back through the history to its end, a result picked shows its
// context beside the list, "Open in conversation" goes there (scrolled to,
// marked), and "Back to results" returns to the same page.
import { test, expect, randomChannel } from './fixtures';
import { connectGuest, joinViaUi, messages } from './helpers/chat';
import { startHistoryProxy, type HistoryProxy } from './helpers/history-proxy';
import { result, resultCount, searchBox, searchPage, searchToTheEnd, seedHistory } from './helpers/search';

test.describe('conversation search', () => {
  let proxy: HistoryProxy | null = null;
  test.afterEach(async () => {
    await proxy?.close();
    proxy = null;
  });

  test('search, page back through the history, open a result and come back', async ({ launchApp }) => {
    test.setTimeout(180_000);
    proxy = await startHistoryProxy();
    const ch = randomChannel('search');
    seedHistory(proxy, ch);
    const { page, nick } = await connectGuest(launchApp, { port: proxy.port });
    await page.setViewportSize({ width: 1280, height: 800 });
    await joinViaUi(page, ch, nick);
    await expect(messages(page).getByText('line 1199 of the backlog')).toBeVisible({ timeout: 30_000 });

    // Ctrl/Cmd+F: the search page, in the chat column (the channel list stays).
    await messages(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await expect(searchPage(page)).toBeVisible();
    await expect(searchBox(page)).toBeFocused();
    await expect(searchPage(page).getByText(`in ${ch}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Channels' })).toBeVisible();

    await searchToTheEnd(page, proxy);
    // None of the fetched history went into the conversation.
    await expect(messages(page).getByText('needle 255 rotate the resolver keys')).toHaveCount(0);

    // Pick a result: its context beside the list, the match marked.
    await result(page, 'needle 255 ').getByRole('button').click();
    const context = page.getByRole('complementary', { name: 'Context' });
    await expect(context.locator('.search-context-current')).toContainText('needle 255 rotate the resolver keys');
    await expect(context.locator('.search-context-current mark')).toHaveText('needle');
    await expect(context.getByText('line 254 of the backlog')).toBeVisible();
    await expect(context.getByText('line 256 of the backlog')).toBeVisible();
    // Arrows move the pick.
    await page.keyboard.press('ArrowUp');
    await expect(context.locator('.search-context-current')).toContainText('needle 355 ');
    await page.keyboard.press('ArrowDown');
    await expect(context.locator('.search-context-current')).toContainText('needle 255 ');

    // Open in conversation: scrolled to it, marked, with the way back.
    await context.getByRole('button', { name: 'Open in conversation' }).click();
    await expect(searchPage(page)).toHaveCount(0);
    const row = messages(page).locator('.vrow-search-current');
    await expect(row).toContainText('needle 255 rotate the resolver keys');
    await expect(row).toBeInViewport();
    // What's around it is there too.
    await expect(messages(page).getByText('line 254 of the backlog')).toBeAttached();
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    // Back to results: the same query, results and pick.
    await page.getByRole('button', { name: 'Back to results' }).click();
    await expect(searchBox(page)).toHaveValue('needle');
    await expect(resultCount(page)).toHaveText('12 results');
    await expect(context.locator('.search-context-current')).toContainText('needle 255 ');
    // Enter opens the pick.
    await searchBox(page).focus();
    await page.keyboard.press('Enter');
    await expect(searchPage(page)).toHaveCount(0);
    await expect(messages(page).locator('.vrow-search-current')).toContainText('needle 255 ');

    // Esc closes the page.
    await page.getByRole('button', { name: 'Back to results' }).click();
    await expect(searchPage(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(searchPage(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Back to results' })).toHaveCount(0);
  });

  test('below 1024px there is no Context panel: a result opens directly', async ({ launchApp }) => {
    proxy = await startHistoryProxy();
    const ch = randomChannel('search');
    seedHistory(proxy, ch);
    const { page, nick } = await connectGuest(launchApp, { port: proxy.port });
    await joinViaUi(page, ch, nick);
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(messages(page).getByText('line 1199 of the backlog')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Search this conversation' }).click();
    await searchBox(page).fill('needle');
    await expect(resultCount(page)).toHaveText('1 result');
    await expect(page.getByRole('complementary', { name: 'Context' })).toHaveCount(0);
    await result(page, 'needle 1155 ').getByRole('button').click();
    await expect(messages(page).locator('.vrow-search-current')).toContainText('needle 1155 ');
    await expect(page.getByRole('button', { name: 'Back to results' })).toBeVisible();
  });
});
