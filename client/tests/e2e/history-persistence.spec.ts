// Flow: connect, join a channel, send 3 distinct messages, reload, sign
// back in, reconnect, and assert all 3 messages are still in scrollback.
// IndexedDB IS available in plain vite-preview (unlike the keychain), so
// IDBChatHistoryStore rows survive a reload. The keychain doesn't, so the
// user must re-type their password — that's the only manual step.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SUPABASE_URL = 'http://localhost:54321';
const BOSON_URL = 'http://localhost:3000';
const ERGO_HOST = 'localhost';
const ERGO_PORT = 6667;

function uniqueEmail(prefix = 'hist'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@local.dev`;
}

async function readAnonKey(): Promise<string> {
  if (process.env.VITE_SUPABASE_ANON_KEY) return process.env.VITE_SUPABASE_ANON_KEY;
  const env = readFileSync('.env', 'utf8');
  const m = env.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m);
  if (!m) throw new Error('VITE_SUPABASE_ANON_KEY not found');
  return m[1]!.trim();
}

async function setupUserAndServer(request: APIRequestContext) {
  const anon = await readAnonKey();
  const email = uniqueEmail();
  const sign = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
    headers: { 'Content-Type': 'application/json', apikey: anon },
    data: { email, password: 'testtest' },
  });
  expect(sign.ok()).toBeTruthy();
  const token = (await sign.json()).access_token as string;
  const handle = 'h' + Date.now().toString().slice(-9);
  const meRes = await request.post(`${BOSON_URL}/me`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { handle, encrypted_user_secret: 'YWJjZA==' },
  });
  expect(meRes.ok()).toBeTruthy();
  const name = `ChatErgo-hist-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const srvRes = await request.post(`${BOSON_URL}/servers`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      hostname: ERGO_HOST,
      port: ERGO_PORT,
      tls: false,
      name,
      description: 'Local ergo for history-persistence E2E',
      tags: ['testing'],
      languages: ['en'],
    },
  });
  expect(srvRes.ok()).toBeTruthy();
  return { email, handle, serverName: name };
}

test.describe('IDB-backed channel scrollback', () => {
  test('3 sent messages survive a page reload + re-sign-in', async ({ page, request }) => {
    const { email, handle, serverName } = await setupUserAndServer(request);

    // ---- Initial session: connect, join, send 3 messages.
    await page.goto('/');
    await page.getByPlaceholder('email').fill(email);
    await page.getByPlaceholder('password').fill('testtest');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(`@${handle}`)).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder('Search servers…').fill(serverName);
    const card = page.locator('.directory-list-item', {
      has: page.getByRole('heading', { name: serverName, exact: true }),
    });
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.channel-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByPlaceholder('#channel-name').pressSequentially('#hist-room');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.locator('.chat-header', { hasText: '#hist-room' }))
      .toBeVisible({ timeout: 10_000 });

    // Three distinct messages stamped with a per-test nonce so they can't
    // collide with a previous run's IDB rows (which would silently pass).
    const nonce = Date.now().toString();
    const messages = [
      `hist-one-${nonce}`,
      `hist-two-${nonce}`,
      `hist-three-${nonce}`,
    ];

    const input = page.getByPlaceholder('Message #hist-room');
    for (const msg of messages) {
      await input.pressSequentially(msg);
      await input.press('Enter');
      // Optimistic echo lands in .message-row-mine.
      await expect(page.locator('.message-row-mine', { hasText: msg }))
        .toBeVisible({ timeout: 5_000 });
    }

    // Reload — IdentityService is in-memory only so we end up on LoginScreen.
    await page.reload();
    await expect(page.getByPlaceholder('email')).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('email').fill(email);
    await page.getByPlaceholder('password').fill('testtest');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(`@${handle}`)).toBeVisible({ timeout: 10_000 });

    // Reconnect via the same row.
    await page.getByPlaceholder('Search servers…').fill(serverName);
    const card2 = page.locator('.directory-list-item', {
      has: page.getByRole('heading', { name: serverName, exact: true }),
    });
    await card2.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.channel-sidebar')).toBeVisible({ timeout: 15_000 });

    // Re-join — IDB rows hydrate on first observation of the channel.
    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByPlaceholder('#channel-name').pressSequentially('#hist-room');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.locator('.chat-header', { hasText: '#hist-room' }))
      .toBeVisible({ timeout: 10_000 });

    // All three original messages are back in the scrollback.
    for (const msg of messages) {
      await expect(page.getByText(msg)).toBeVisible({ timeout: 10_000 });
    }
  });
});
