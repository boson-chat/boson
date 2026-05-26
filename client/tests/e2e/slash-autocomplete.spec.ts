// Flow: connect + join a channel, then exercise the slash-command
// autocomplete popup in the chat textarea. The popup is a div.slash-autocomplete
// with role="listbox"; Tab cycles through the matches by *replacing the input*
// with "/<cmd> " (see ChatInputBloc.beginCommandCycle / advanceCommandCycle).
//
// @-mention autocomplete is NOT exercised in this spec — it requires the
// channel to have known members, which means either a second connected user
// or one of the ergo bots responding to NAMES. Setting that up reliably from
// inside a single Playwright session adds substantial flake risk, so we punt
// and document the gap; the unit tests in
// src/renderer/src/screens/ChatLayout/ChatInputBloc.test.ts cover the
// mention-cycle logic directly.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SUPABASE_URL = 'http://localhost:54321';
const BOSON_URL = 'http://localhost:3000';
const ERGO_HOST = 'localhost';
const ERGO_PORT = 6667;

function uniqueEmail(prefix = 'slash'): string {
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
  const handle = 'l' + Date.now().toString().slice(-9);
  const meRes = await request.post(`${BOSON_URL}/me`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { handle, encrypted_user_secret: 'YWJjZA==' },
  });
  expect(meRes.ok()).toBeTruthy();
  const name = `ChatErgo-slash-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const srvRes = await request.post(`${BOSON_URL}/servers`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      hostname: ERGO_HOST,
      port: ERGO_PORT,
      tls: false,
      name,
      description: 'Local ergo for slash-autocomplete E2E',
      tags: ['testing'],
      languages: ['en'],
    },
  });
  expect(srvRes.ok()).toBeTruthy();
  return { email, handle, serverName: name };
}

test.describe('Slash-command autocomplete', () => {
  test('typing / opens the listbox, Tab cycles to /join then /part', async ({ page, request }) => {
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
    await page.getByPlaceholder('#channel-name').pressSequentially('#slash-room');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.locator('.chat-header', { hasText: '#slash-room' }))
      .toBeVisible({ timeout: 10_000 });

    // Typing "/" should open the slash-autocomplete listbox. The textarea
    // placeholder is dynamic per active channel: `Message #slash-room`.
    const input = page.getByPlaceholder('Message #slash-room');
    await input.focus();
    await input.pressSequentially('/');

    const listbox = page.getByRole('listbox', { name: 'Slash command autocomplete' });
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    // At least the canonical commands: /join, /part, /msg, /me, /clear, /help
    // are present. We check >=2 rather than ===6 so adding a future command
    // doesn't break the test.
    const options = listbox.getByRole('option');
    await expect.poll(async () => (await options.count())).toBeGreaterThanOrEqual(2);

    // Tab → commandCycle begins on the first match, which is /join because
    // SLASH_COMMANDS lists `join` before `part` in chat.service.ts.
    await input.press('Tab');
    await expect(input).toHaveValue('/join ');

    // Tab again → advance to /part.
    await input.press('Tab');
    await expect(input).toHaveValue('/part ');

    // Escape dismisses the popup. Because the input is currently `/part `
    // (with a trailing space) the popup is already closed — re-open it by
    // resetting the value to `/`, then Escape, then assert the popup is gone.
    await input.fill('');
    await input.pressSequentially('/');
    await expect(listbox).toBeVisible();
    await input.press('Escape');
    await expect(listbox).not.toBeVisible({ timeout: 5_000 });
  });
});
