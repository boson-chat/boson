// Flow: connect to ergo so ChatLayout is on screen, then click the
// server-rail "+" (aria-label "Browse / switch servers", NOT to be confused
// with the channel-sidebar "+" which is "Add channel"). The DirectoryScreen
// renders inside a Modal overlay; the underlying ChatService stays attached.
// Closing the modal returns the user to the live chat with no disconnect.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SUPABASE_URL = 'http://localhost:54321';
const BOSON_URL = 'http://localhost:3000';
const ERGO_HOST = 'localhost';
const ERGO_PORT = 6667;

function uniqueEmail(prefix = 'dirmod'): string {
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
  const handle = 'd' + Date.now().toString().slice(-9);
  const meRes = await request.post(`${BOSON_URL}/me`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { handle, encrypted_user_secret: 'YWJjZA==' },
  });
  expect(meRes.ok()).toBeTruthy();
  // Prefix `ChatErgo-` so the teardown sweep at tests/e2e/global-teardown.ts
  // picks it up — it already lists ChatErgo- / LocalErgo- / etc.
  const name = `ChatErgo-dirmod-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const srvRes = await request.post(`${BOSON_URL}/servers`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      hostname: ERGO_HOST,
      port: ERGO_PORT,
      tls: false,
      name,
      description: 'Local ergo for directory-modal E2E',
      tags: ['testing'],
      languages: ['en'],
    },
  });
  expect(srvRes.ok()).toBeTruthy();
  return { email, handle, serverName: name };
}

test.describe('Directory modal overlay', () => {
  test('opens from server-rail +, shows current-server badge, closes without disconnecting', async ({ page, request }) => {
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

    // The server-rail's "+" has the title/aria-label "Browse / switch servers".
    // It must NOT match the channel-sidebar "+" (aria-label "Add channel").
    await page.getByRole('button', { name: 'Browse / switch servers' }).click();

    // Modal mounts: role="dialog" + aria-label = the title prop.
    const modal = page.getByRole('dialog', { name: 'Connect to a server' });
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // The same row inside the modal shows the "Currently connected" badge
    // (rendered when `connectedServer.id === server.id`). Text doesn't match
    // the prompt's hypothetical "CURRENT" — DirectoryScreen.tsx renders the
    // longer human-readable label inside .directory-current-badge.
    const modalCard = modal.locator('.directory-list-item', {
      has: page.getByRole('heading', { name: serverName, exact: true }),
    });
    await expect(modalCard).toBeVisible();
    await expect(modalCard.locator('.directory-current-badge'))
      .toContainText('Currently connected');

    // Close via the × button (Modal renders it with aria-label "Close").
    await modal.getByRole('button', { name: 'Close' }).click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });

    // Chat survived the modal open/close cycle — channel sidebar still mounted,
    // server name still showing in the sidebar header.
    await expect(page.locator('.channel-sidebar')).toBeVisible();
    await expect(page.locator('.sidebar-server-name', { hasText: serverName }))
      .toBeVisible();
  });
});
