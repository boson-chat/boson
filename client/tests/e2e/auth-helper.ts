// Accounts for the browser-only suite, against the dev stack's auth service
// (`make auth-up`: API on :8080, its Mailpit on :8026). Registration needs a
// verified email before sign-in, so this registers, opens the verification
// link (posts its token, as the auth service's /verify-email page does) and
// signs in.
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const AUTH_URL = process.env.E2E_AUTH_URL ?? 'http://localhost:8080';
export const AUTH_MAILPIT_URL = process.env.E2E_AUTH_MAILPIT_URL ?? 'http://localhost:8026';
// The auth service wants 10+ characters.
export const TEST_PASSWORD = 'testtest-password';

export function usernameFor(email: string): string {
  return `u${email.split('@')[0]!.replace(/[^A-Za-z0-9]/g, '').slice(-20)}`;
}

async function verificationToken(request: APIRequestContext, email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const list = await (await request.get(`${AUTH_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    for (const m of list.messages ?? []) {
      const msg = await (await request.get(`${AUTH_MAILPIT_URL}/api/v1/message/${m.ID}`)).json();
      const hit = /\/verify-email#token=([A-Za-z0-9_-]+)/.exec(msg.Text ?? '');
      if (hit) return hit[1]!;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no verification mail for ${email} in ${AUTH_MAILPIT_URL}`);
}

// Registers + verifies `email` (username derived from it) and returns an
// access token for the Boson API.
export async function signUpVerified(
  request: APIRequestContext,
  email: string,
  password = TEST_PASSWORD,
): Promise<{ email: string; username: string; password: string; token: string }> {
  const username = usernameFor(email);
  const reg = await request.post(`${AUTH_URL}/v1/register`, { data: { username, email, password } });
  expect(reg.ok(), await reg.text()).toBeTruthy();
  const verify = await request.post(`${AUTH_URL}/v1/email/verify`, { data: { token: await verificationToken(request, email) } });
  expect(verify.ok(), await verify.text()).toBeTruthy();
  const login = await request.post(`${AUTH_URL}/v1/login`, { data: { login: email, password } });
  expect(login.ok(), await login.text()).toBeTruthy();
  return { email, username, password, token: (await login.json()).access_token as string };
}

// An access token for an existing, verified account.
export async function loginToken(request: APIRequestContext, login: string, password = TEST_PASSWORD): Promise<string> {
  const res = await request.post(`${AUTH_URL}/v1/login`, { data: { login, password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).access_token as string;
}

// Sign-up through the login screen: Signup tab → form → "Check your email."
// → the link is opened (token posted) → Continue signs in. The app then
// shows the first-sign-in handle setup.
export async function signUpInUi(page: Page, request: APIRequestContext, email: string, password = TEST_PASSWORD): Promise<string> {
  const username = usernameFor(email);
  await page.getByRole('tab', { name: 'Signup' }).click();
  await page.getByPlaceholder('username', { exact: true }).fill(username);
  await page.getByPlaceholder('email', { exact: true }).fill(email);
  await page.getByPlaceholder('password', { exact: true }).fill(password);
  await page.getByPlaceholder('confirm password').fill(password);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible({ timeout: 15_000 });
  const verify = await request.post(`${AUTH_URL}/v1/email/verify`, { data: { token: await verificationToken(request, email) } });
  expect(verify.ok(), await verify.text()).toBeTruthy();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  return username;
}
