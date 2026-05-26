// Flow: sign in → DirectoryScreen connect to ergo → ChatLayout (ServerRail +
// ChannelSidebar + ChatArea). Exercises the channel-join modal in the sidebar
// (aria-label "Add channel" — NOT the server-rail "+" which is "Browse /
// switch servers"), message send, and leaving a channel via the row's × button.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SUPABASE_URL = 'http://localhost:54321';
const BOSON_URL = 'http://localhost:3000';
const ERGO_HOST = 'localhost';
const ERGO_PORT = 6667;

function uniqueEmail(prefix = 'chat'): string {
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
  const handle = 'c' + Date.now().toString().slice(-9);
  const meRes = await request.post(`${BOSON_URL}/me`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { handle, encrypted_user_secret: 'YWJjZA==' },
  });
  expect(meRes.ok()).toBeTruthy();

  const name = `ChatErgo-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const srvRes = await request.post(`${BOSON_URL}/servers`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      hostname: ERGO_HOST,
      port: ERGO_PORT,
      tls: false,
      name,
      description: 'Local ergo for chat E2E',
      tags: ['testing'],
      languages: ['en'],
    },
  });
  expect(srvRes.ok()).toBeTruthy();
  return { email, handle, serverName: name };
}

test.describe('Chat flow', () => {
  test('connect to ergo, join channel, send message, see own echo', async ({ page, request }) => {
    const { email, handle, serverName } = await setupUserAndServer(request);

    await page.goto('/');
    await page.getByPlaceholder('email').fill(email);
    await page.getByPlaceholder('password').fill('testtest');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText(`@${handle}`)).toBeVisible({ timeout: 10_000 });

    // Find our ergo card and connect.
    await page.getByPlaceholder('Search servers…').fill(serverName);
    const card = page.locator('.directory-list-item', {
      has: page.getByRole('heading', { name: serverName, exact: true }),
    });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: 'Connect' }).click();

    // Directory auto-switches into ChatLayout once status flips to connected.
    await expect(page.locator('.channel-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.sidebar-server-name', { hasText: serverName })).toBeVisible();

    // Join a channel via the "+" button → modal.
    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByPlaceholder('#channel-name').pressSequentially('#boson-test');
    await page.getByRole('button', { name: 'Join' }).click();

    // Channel becomes active (header shows the name).
    await expect(page.locator('.chat-header', { hasText: '#boson-test' })).toBeVisible({ timeout: 10_000 });

    // System message confirms the join.
    await expect(page.getByText('You joined #boson-test')).toBeVisible({ timeout: 10_000 });

    // Send a message — should appear optimistically.
    const messageText = `hello world ${Date.now()}`;
    await page.getByPlaceholder('Message #boson-test').pressSequentially(messageText);
    await page.getByPlaceholder('Message #boson-test').press('Enter');

    await expect(page.getByText(messageText)).toBeVisible({ timeout: 5_000 });
    // Our own line should be tagged 'mine'.
    await expect(page.locator(`.message-row-mine`, { hasText: messageText })).toBeVisible();
  });

  test('leaving a channel removes it from the sidebar', async ({ page, request }) => {
    const { email, handle, serverName } = await setupUserAndServer(request);

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
    await page.getByPlaceholder('#channel-name').pressSequentially('#leave-me');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.locator('.channel-name', { hasText: '#leave-me' })).toBeVisible({ timeout: 10_000 });

    const channelRow = page.locator('.channel-item', {
      has: page.locator('.channel-name', { hasText: '#leave-me' }),
    });
    // Native click via evaluate — Playwright's synthesizer hits a stability
    // timeout on the small × button on this Electron/WSL stack.
    await channelRow.locator('.channel-leave').evaluate((el) => (el as HTMLButtonElement).click());

    await expect(page.locator('.channel-name', { hasText: '#leave-me' })).not.toBeVisible({ timeout: 5_000 });
  });
});
