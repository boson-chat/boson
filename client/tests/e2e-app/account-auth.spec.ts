// Account sign-up / sign-in edge cases, the destructive "Start fresh" path,
// and a real "forgot password" round trip through the auth mailbox — all
// through the login screen of the built app, with the outcome checked in
// Supabase Auth and the backend.
import type { Page } from '@playwright/test';
import {
  test, expect, STACK,
  backendSql, completeHandleSetup, confirmSignup, extractLinks, findAuthUserByEmail, loginAs, randomEmail, randomHandle,
  randomPassword, recoverWithCode, setAuthPassword, signInWithPassword, signOut, signUpViaUi, submitLogin,
  deleteAuthUser,
} from './fixtures';

const loginError = (page: Page) => page.locator('.login-error');

async function fillSignup(page: Page, email: string, password: string, confirm = password): Promise<void> {
  await page.getByRole('tab', { name: 'Signup' }).click();
  await page.getByPlaceholder('email', { exact: true }).fill(email);
  await page.getByPlaceholder('password', { exact: true }).fill(password);
  await page.getByPlaceholder('confirm password').fill(confirm);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
}

test.describe('sign up', () => {
  test('rejects mismatched passwords, a short password and a malformed email without creating a user', async ({ launchApp }) => {
    const { page } = await launchApp();
    const email = randomEmail('badsignup');

    // Mismatch is caught locally, before Supabase is asked.
    await fillSignup(page, email, 'abcdef123', 'abcdef124');
    await expect(loginError(page)).toHaveText("Passwords don't match.");

    // Switching tabs clears the stale error.
    await page.getByRole('tab', { name: 'Login' }).click();
    await expect(loginError(page)).toBeHidden();

    // GoTrue enforces minimum_password_length = 6.
    await fillSignup(page, email, 'abc', 'abc');
    await expect(loginError(page)).toContainText(/at least 6 characters/i);

    // A malformed address is refused by GoTrue.
    await fillSignup(page, 'not-an-email', 'abcdef123');
    await expect(loginError(page)).toContainText(/email/i);

    await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeHidden();
    expect(await findAuthUserByEmail(email)).toBeNull();
  });

  test('signing up with an already registered email is refused and leaves the account alone', async ({ launchApp, account }) => {
    const { page } = await launchApp();
    const before = await findAuthUserByEmail(account.email);
    // GoTrue refuses (422 "User already registered"); no confirmation mail
    // is sent and the form stays up with the address for another try.
    await fillSignup(page, account.email, randomPassword());
    await expect(loginError(page)).toContainText(/already registered/i);
    await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeHidden();
    await expect(page.getByPlaceholder('email', { exact: true })).toHaveValue(account.email);
    // The existing user is untouched and keeps its password.
    const after = await findAuthUserByEmail(account.email);
    expect(after!.id).toBe(before!.id);
    expect(after!.email_confirmed_at).toBe(before!.email_confirmed_at);
    await expect(signInWithPassword(account.email, account.password)).resolves.toMatchObject({ userId: account.id });
    // And the real owner can still sign straight in.
    expect(await loginAs(page, account)).toBe('directory');
  });

  test('an unconfirmed account cannot sign in until the email is confirmed', async ({ launchApp }) => {
    const email = randomEmail('unconf');
    const password = randomPassword();
    const { app, page } = await launchApp();
    let userId: string | null = null;
    try {
      await signUpViaUi(page, { email, password });
      userId = (await findAuthUserByEmail(email))!.id;
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByPlaceholder('email', { exact: true })).toHaveValue(email);

      await submitLogin(page, { email, password });
      await expect(loginError(page)).toContainText(/not confirmed/i);
      await expect(page.locator('.login-screen')).toBeVisible();
      expect((await findAuthUserByEmail(email))!.email_confirmed_at).toBeNull();

      // Confirming (the mail link → boson:// deep link) lifts it; the first
      // sign-in then asks for a handle.
      await confirmSignup(app, email);
      expect((await findAuthUserByEmail(email))!.email_confirmed_at).not.toBeNull();
      expect(await loginAs(page, { email, password })).toBe('setup');
    } finally {
      if (userId) await deleteAuthUser(userId).catch(() => {});
    }
  });
});

test.describe('sign in', () => {
  test('wrong password and unknown email are refused; the right password then works', async ({ launchApp, account }) => {
    const { page } = await launchApp();

    await submitLogin(page, { email: account.email, password: `${account.password}x` });
    await expect(loginError(page)).toContainText('Invalid login credentials');
    await expect(page.locator('.login-recovery')).toBeHidden();

    await submitLogin(page, { email: randomEmail('nobody'), password: randomPassword() });
    await expect(loginError(page)).toContainText('Invalid login credentials');

    expect(await loginAs(page, account)).toBe('directory');
    await expect(page.locator('.directory-handle')).toHaveText(`@${account.handle}`);
  });

  test('sign out and back in, and a relaunch after sign-out asks for the password again', async ({ launchApp, account }) => {
    const first = await launchApp();
    expect(await loginAs(first.page, account)).toBe('directory');
    await signOut(first.page);
    // The keychain copy of the identity secret is gone with the session.
    expect(await first.page.evaluate(
      (key) => (window as unknown as { bosonSecure: { get(k: string): Promise<string | null> } }).bosonSecure.get(key),
      `boson.identity.${account.id}`,
    )).toBeNull();
    expect(await loginAs(first.page, account)).toBe('directory');
    await signOut(first.page);
    await first.app.close();

    const second = await launchApp();
    await expect(second.page.locator('.login-screen')).toBeVisible({ timeout: 30_000 });
    await expect(second.page.getByRole('tab', { name: 'Login', selected: true })).toBeVisible();
    expect(await loginAs(second.page, account)).toBe('directory');
  });

  test('a password unlock failure without a recovery wrap explains what to do', async ({ launchApp, account }) => {
    // An account from before recovery codes existed: no recovery wrap.
    backendSql(`UPDATE users SET encrypted_user_secret_recovery = NULL WHERE id = '${account.id}'`);
    const newPassword = randomPassword();
    await setAuthPassword(account.id, newPassword);

    const { page } = await launchApp();
    await submitLogin(page, { email: account.email, password: newPassword });
    await expect(loginError(page)).toContainText("Couldn't decrypt your identity key. Use the same password you signed up with.");
    await expect(page.locator('.login-recovery')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Start fresh' })).toBeHidden();
  });

  test('a wrong recovery code is rejected and the right one still unlocks', async ({ launchApp, account }) => {
    const newPassword = randomPassword();
    await setAuthPassword(account.id, newPassword);
    const { page } = await launchApp();
    await submitLogin(page, { email: account.email, password: newPassword });
    await expect(loginError(page)).toContainText('enter your recovery code');

    const recovery = page.getByPlaceholder('xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx');
    await recovery.fill('aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh');
    await page.getByRole('button', { name: 'Recover with code' }).click();
    await expect(loginError(page)).toContainText('Recovery code rejected');
    await expect(page.locator('.login-screen')).toBeVisible();

    await recoverWithCode(page, account.recoveryCode!);
    await expect(page.locator('.directory-handle')).toHaveText(`@${account.handle}`);
  });
});

test('an undecryptable stored identity offers "Start fresh", which deletes and recreates the account row', async ({ launchApp, account, backendApi }) => {
  // A truncated wrap (leftover test data) can never decrypt.
  backendSql(`UPDATE users SET encrypted_user_secret = '\\x0102'::bytea WHERE id = '${account.id}'`);
  const { page } = await launchApp();
  await submitLogin(page, account);
  await expect(loginError(page)).toContainText('Your stored identity key is invalid');
  await page.getByRole('button', { name: 'Start fresh' }).click();

  // DELETE /me ran: the user is new to the backend, so the handle setup shows.
  await expect(page.getByRole('heading', { name: 'Finish setting up your account' })).toBeVisible({ timeout: 30_000 });
  expect(backendSql(`SELECT count(*) FROM users WHERE id = '${account.id}'`)).toBe('0');

  const handle = randomHandle('fresh');
  const code = await completeHandleSetup(page, handle);
  const me = await (await backendApi(account)).get<{ handle: string; encrypted_user_secret: string; encrypted_user_secret_recovery: string }>('/me');
  expect(me.handle).toBe(handle);
  expect(me.encrypted_user_secret.length).toBeGreaterThan(40);
  expect(me.encrypted_user_secret_recovery.length).toBeGreaterThan(40);
  expect(code).not.toBe(account.recoveryCode);

  // The fresh identity opens with the same password on the next sign-in.
  await signOut(page);
  expect(await loginAs(page, account)).toBe('directory');
  await expect(page.locator('.directory-handle')).toHaveText(`@${handle}`);
});

// "Forgot password" happens on the web (Supabase's recovery mail); the app
// then sees a password that no longer opens the identity wrap.
test('forgot password: the reset mail sets a new password, and the recovery code re-wraps the identity for it', async ({ launchApp, account, mailpit }) => {
  const api = (path: string, init: RequestInit & { token?: string } = {}) => fetch(`${STACK.supabase.apiUrl}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: STACK.supabase.publishableKey,
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
  });

  const res = await api('/recover', { method: 'POST', body: JSON.stringify({ email: account.email }) });
  expect(res.ok, await res.clone().text()).toBe(true);
  const mail = await mailpit.users.waitFor({ to: account.email, subject: /reset/i });
  const link = extractLinks(mail).find((l) => l.includes('/auth/v1/verify') && l.includes('type=recovery'));
  expect(link, mail.Text).toBeTruthy();
  const verify = await fetch(link!, { redirect: 'manual' });
  expect([301, 302, 303]).toContain(verify.status);
  const landing = new URL(verify.headers.get('location')!);
  const fragment = new URLSearchParams(landing.hash.replace(/^#/, ''));
  expect(fragment.get('type')).toBe('recovery');
  const accessToken = fragment.get('access_token')!;
  expect(accessToken).toBeTruthy();

  const newPassword = randomPassword();
  const upd = await api('/user', { method: 'PUT', token: accessToken, body: JSON.stringify({ password: newPassword }) });
  expect(upd.ok, await upd.clone().text()).toBe(true);
  await expect(signInWithPassword(account.email, account.password)).rejects.toThrow();

  const wrapBefore = backendSql(`SELECT encode(encrypted_user_secret, 'base64') FROM users WHERE id = '${account.id}'`);
  const { page } = await launchApp();
  // The old password is gone for good …
  await submitLogin(page, { email: account.email, password: account.password });
  await expect(loginError(page)).toContainText('Invalid login credentials');
  // … the new one signs in but needs the recovery code once.
  await submitLogin(page, { email: account.email, password: newPassword });
  await expect(loginError(page)).toContainText('enter your recovery code');
  await recoverWithCode(page, account.recoveryCode!);
  await expect(page.locator('.directory-handle')).toHaveText(`@${account.handle}`);
  await expect.poll(() => backendSql(`SELECT encode(encrypted_user_secret, 'base64') FROM users WHERE id = '${account.id}'`))
    .not.toBe(wrapBefore);

  await signOut(page);
  expect(await loginAs(page, { email: account.email, password: newPassword })).toBe('directory');
});
