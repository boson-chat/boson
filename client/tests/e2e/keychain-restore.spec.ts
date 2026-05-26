// Flow: sign in, connect, join a channel, reload — and assert the saved-
// session signals that DON'T require the real Electron keychain preload
// bridge. Under vite-preview `window.bosonSecure` is undefined, so
// SecureStorage falls back to a per-tab in-memory Map and the user_secret
// dies on reload. We assert:
//   1. The `boson:session:v1` localStorage row IS written and persists
//      across reload (it's what the real client would consume on next launch).
//   2. After reload the renderer lands on LoginScreen — documented gap;
//      real Electron would skip straight back into chat.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SUPABASE_URL = 'http://localhost:54321';
const BOSON_URL = 'http://localhost:3000';
const ERGO_HOST = 'localhost';
const ERGO_PORT = 6667;

function uniqueEmail(prefix = 'kchain'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@local.dev`;
}

async function readAnonKey(): Promise<string> {
  if (process.env.VITE_SUPABASE_ANON_KEY) return process.env.VITE_SUPABASE_ANON_KEY;
  const env = readFileSync('.env', 'utf8');
  const m = env.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m);
  if (!m) throw new Error('VITE_SUPABASE_ANON_KEY not found');
  return m[1]!.trim();
}

// Bootstraps a fresh Supabase user, creates the `/me` row, and registers an
// ergo-pointed server. Mirrors `setupUserAndServer` in chat.spec.ts so the
// teardown name-prefix sweep covers it (ChatErgo-* is on the cleanup list).
async function setupUserAndServer(request: APIRequestContext) {
  const anon = await readAnonKey();
  const email = uniqueEmail();
  const sign = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
    headers: { 'Content-Type': 'application/json', apikey: anon },
    data: { email, password: 'testtest' },
  });
  expect(sign.ok()).toBeTruthy();
  const token = (await sign.json()).access_token as string;
  const handle = 'k' + Date.now().toString().slice(-9);
  const meRes = await request.post(`${BOSON_URL}/me`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { handle, encrypted_user_secret: 'YWJjZA==' },
  });
  expect(meRes.ok()).toBeTruthy();
  const name = `ChatErgo-kchain-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const srvRes = await request.post(`${BOSON_URL}/servers`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      hostname: ERGO_HOST,
      port: ERGO_PORT,
      tls: false,
      name,
      description: 'Local ergo for keychain-restore E2E',
      tags: ['testing'],
      languages: ['en'],
    },
  });
  expect(srvRes.ok()).toBeTruthy();
  return { email, handle, serverName: name };
}

test.describe('Saved-session restore (vite-preview limited)', () => {
  test('reload preserves Supabase session, attempts identity restore, falls back to login', async ({ page, request }) => {
    const { email, handle, serverName } = await setupUserAndServer(request);

    await page.goto('/');
    await page.getByPlaceholder('email').fill(email);
    await page.getByPlaceholder('password').fill('testtest');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(`@${handle}`)).toBeVisible({ timeout: 10_000 });

    // Connect to ergo and join a channel — this populates the SessionStore
    // (boson:session:v1 in localStorage) which is what the restore path
    // consumes on the next page load.
    await page.getByPlaceholder('Search servers…').fill(serverName);
    const card = page.locator('.directory-list-item', {
      has: page.getByRole('heading', { name: serverName, exact: true }),
    });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.channel-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Add channel' }).click();
    await page.getByPlaceholder('#channel-name').pressSequentially('#kchain-room');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.locator('.chat-header', { hasText: '#kchain-room' }))
      .toBeVisible({ timeout: 10_000 });

    // Verify the SessionStore captured the connection — this is the data the
    // real Electron client would consume on next launch.
    const savedBeforeReload = await page.evaluate(() =>
      window.localStorage.getItem('boson:session:v1'),
    );
    expect(savedBeforeReload).not.toBeNull();
    const parsedBefore = JSON.parse(savedBeforeReload!);
    expect(parsedBefore.server?.name).toBe(serverName);
    expect(parsedBefore.channels).toContain('#kchain-room');

    await page.reload();

    // Saved session row is still on disk regardless of which screen lands.
    const savedAfterReload = await page.evaluate(() =>
      window.localStorage.getItem('boson:session:v1'),
    );
    expect(savedAfterReload).not.toBeNull();

    // Documented gap: end state is LoginScreen because the keychain bridge
    // is absent. Real Electron would land directly in chat.
    await expect(page.getByPlaceholder('email')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder('password')).toBeVisible();
  });
});
