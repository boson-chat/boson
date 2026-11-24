// The full-page conversation search (chat-search.spec.ts, mobile-search.spec.ts):
// a channel whose server keeps ~1200 lines of history (the history proxy in
// front of the e2e ergo answers CHATHISTORY), so finding everything needs
// "Older results" more than once.
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { HistoryLine, HistoryProxy } from './history-proxy';

export const HISTORY_LINES = 1200;

// Line i: a minute apart, the newest a minute ago. Every 100th (from 55) says
// "needle <i>", so 12 match: one in the newest 50 (what the join loads),
// five in each of the next two batches of 500, and one in the last 150.
export function seedHistory(proxy: HistoryProxy, channel: string): HistoryLine[] {
  const now = Date.now();
  const who = ['kestrel', 'mox', 'nova', 'pixel'];
  const lines = Array.from({ length: HISTORY_LINES }, (_, i) => ({
    time: now - (HISTORY_LINES - i) * 60_000,
    from: who[i % who.length]!,
    text: i % 100 === 55 ? `needle ${i} rotate the resolver keys` : `line ${i} of the backlog`,
  }));
  proxy.setHistory(channel, lines);
  return lines;
}

export function searchPage(page: Page): Locator {
  return page.locator('.search-page');
}

export function searchBox(page: Page): Locator {
  return page.getByRole('searchbox', { name: 'Search messages' });
}

export function resultCount(page: Page): Locator {
  return searchPage(page).locator('.search-count');
}

export function result(page: Page, text: string): Locator {
  return searchPage(page).locator('li.search-result').filter({ hasText: text });
}

export function olderResults(page: Page): Locator {
  return searchPage(page).getByRole('button', { name: 'Older results' });
}

// Older results, and wait for the fetch to finish.
export async function fetchOlder(page: Page): Promise<void> {
  await olderResults(page).click();
  await expect(searchPage(page).locator('.search-older[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
}

// Page back to the end of the server's history: 12 results, and it says so.
export async function searchToTheEnd(page: Page, proxy: HistoryProxy): Promise<void> {
  await searchBox(page).fill('needle');
  await expect(resultCount(page)).toHaveText('1 result');
  await expect(searchPage(page).getByText('Fetches the next 500 messages from the server')).toBeVisible();
  await fetchOlder(page);
  await expect(resultCount(page)).toHaveText('6 results');
  await fetchOlder(page);
  await expect(resultCount(page)).toHaveText('11 results');
  await fetchOlder(page);
  await expect(resultCount(page)).toHaveText('12 results');
  await expect(searchPage(page).getByText("That's everything the server keeps for this channel.")).toBeVisible();
  await expect(olderResults(page)).toHaveCount(0);
  // Newest first: the last result is the oldest line.
  await expect(searchPage(page).locator('li.search-result').last()).toContainText('needle 55 ');
  // Only CHATHISTORY went to the server: never the query.
  expect(proxy.requests.filter((r) => / BEFORE /.test(r)).length).toBeGreaterThanOrEqual(13);
  expect(proxy.requests.some((r) => /needle/i.test(r))).toBe(false);
}
