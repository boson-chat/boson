// Flow: bootstrap a user + register an ergo server via REST, then drive the
// renderer Sign-in → Directory Connect button and assert the engine reaches
// connected state (signal: ChatLayout's .channel-sidebar mounts).
import { test, expect, type APIRequestContext } from '@playwright/test';

const SUPABASE_URL = 'http://localhost:54321';
const BOSON_URL = 'http://localhost:3000';
const ERGO_HOST = 'localhost';
const ERGO_PORT = 6667;

// Helpers -----------------------------------------------------------------

function uniqueEmail(prefix = 'engine'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@local.dev`;
}

interface Bootstrapped {
  email: string;
  handle: string;
  token: string;
  ergoServerId: string;
  ergoServerName: string;
}

// Sign up a fresh Supabase user, create the boson user row, and register
// an ergo-pointed server. Returns the credentials and the new server's ID.
async function bootstrap(request: APIRequestContext): Promise<Bootstrapped> {
  // Read the local Supabase anon key from `supabase status` output via the env
  // file we already populate for the renderer.
  const anon = process.env.VITE_SUPABASE_ANON_KEY ?? await readAnonKey(request);

  const email = uniqueEmail();
  const signupRes = await request.post(`${SUPABASE_URL}/auth/v1/signup`, {
    headers: { 'Content-Type': 'application/json', apikey: anon },
    data: { email, password: 'testtest' },
  });
  expect(signupRes.ok()).toBeTruthy();
  const signup = await signupRes.json();
  const token: string = signup.access_token;

  const handle = 'e' + Date.now().toString().slice(-9);
  const meRes = await request.post(`${BOSON_URL}/me`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { handle, encrypted_user_secret: 'YWJjZA==' },
  });
  expect(meRes.ok()).toBeTruthy();

  // Unique name per test run so this card never collides with one left behind
  // by a previous run.
  const ergoServerName = `LocalErgo-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const srvRes = await request.post(`${BOSON_URL}/servers`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      hostname: ERGO_HOST,
      port: ERGO_PORT,
      tls: false,
      name: ergoServerName,
      description: 'Local ergo for E2E',
      tags: ['testing'],
      languages: ['en'],
    },
  });
  expect(srvRes.ok()).toBeTruthy();
  const server = await srvRes.json();

  return { email, handle, token, ergoServerId: server.id, ergoServerName };
}

async function readAnonKey(_request: APIRequestContext): Promise<string> {
  // Lazy import for node-only access.
  const { readFileSync } = await import('node:fs');
  const env = readFileSync('.env', 'utf8');
  const match = env.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/m);
  if (!match) throw new Error('VITE_SUPABASE_ANON_KEY not in client/.env');
  return match[1]!.trim();
}

// Tests -------------------------------------------------------------------

test.describe('Engine bridge', () => {
  test('Connect button drives engine through to ergo and flips status to connected', async ({ page, request }) => {
    const { email, handle, ergoServerName } = await bootstrap(request);

    // Make the renderer pick up the Supabase session by signing in with the
    // user we just created via the API.
    await page.goto('/');
    await page.getByPlaceholder('email').fill(email);
    await page.getByPlaceholder('password').fill('testtest');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // We already created the user row, so directory loads directly.
    await expect(page.getByText(`@${handle}`)).toBeVisible({ timeout: 10_000 });

    // Search to surface the card.
    await page.getByPlaceholder('Search servers…').fill(ergoServerName);
    const ergoCard = page.locator('.directory-list-item', {
      has: page.getByRole('heading', { name: ergoServerName, exact: true }),
    });
    await expect(ergoCard).toBeVisible({ timeout: 10_000 });
    await ergoCard.getByRole('button', { name: 'Connect' }).click();

    // After RPL_WELCOME the directory auto-switches to the chat layout, so
    // sidebar visibility is the strongest "fully connected" signal.
    await expect(page.locator('.channel-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.sidebar-server-name', { hasText: ergoServerName })).toBeVisible();
  });
});
