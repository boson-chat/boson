// Account sign-up / sign-in edge cases, the destructive "Start fresh" path,
// and a real "forgot password" round trip through the auth mailbox — all
// through the login screen of the built app, with the outcome checked in
// the auth service and the backend.
import type { Page } from '@playwright/test';
import {
  test, expect,
  backendSql, completeHandleSetup, confirmSignup, emailToken, findAuthUserByEmail, loginAs, randomEmail, randomHandle,
  randomPassword, randomUsername, recoverWithCode, setAuthPassword, signInWithPassword, signOut, signUpViaUi, submitLogin,
  deleteAuthUser, authApi,
} from './fixtures';

const loginError = (page: Page) => page.locator('.login-error');

async function fillSignup(page: Page, email: string, password: string, confirm = password, username = randomUsername('s')): Promise<void> {
  await page.getByRole('tab', { name: 'Signup' }).click();
  await page.getByPlaceholder('username', { exact: true }).fill(username);
  await page.getByPlaceholder('email', { exact: true }).fill(email);
  await page.getByPlaceholder('password', { exact: true }).fill(password);
  await page.getByPlaceholder('confirm password').fill(confirm);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
}

test.describe('sign up', () => {
  test('rejects mismatched passwords, a bad username, a short password and a malformed email without creating a user', async ({ launchApp }) => {
    const { page } = await launchApp();
    const email = randomEmail('badsignup');

    // Mismatch is caught locally, before the auth service is asked.
    await fillSignup(page, email, 'abcdef12345', 'abcdef12346');
    await expect(loginError(page)).toHaveText("Passwords don't match.");

    // Switching tabs clears the stale error.
    await page.getByRole('tab', { name: 'Login' }).click();
    await expect(loginError(page)).toBeHidden();

    // Usernames are IRC nicks: checked as you type, and again on submit.
    await fillSignup(page, email, 'abcdef12345', 'abcdef12345', '9 lives');
    await expect(page.locator('.bds-field-error')).toBeVisible();
    await expect(loginError(page)).toContainText(/^Username:/);

    // The auth service wants 10+ characters.
    await fillSignup(page, email, 'abc', 'abc');
    await expect(loginError(page)).toContainText(/at least 10 characters/i);

    // A malformed address is refused by the auth service.
    await fillSignup(page, 'not-an-email', 'abcdef12345');
    await expect(loginError(page)).toContainText(/email/i);

    await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeHidden();
    expect(await findAuthUserByEmail(email)).toBeNull();
  });

  test('signing up with an already registered email is refused and leaves the account alone', async ({ launchApp, account }) => {
    const { page } = await launchApp();
    const before = await findAuthUserByEmail(account.email);
    // The auth service refuses (409 email_taken); no mail is sent and the
    // form stays up with the address for another try.
    await fillSignup(page, account.email, randomPassword());
    await expect(loginError(page)).toContainText(/already exists/i);
    await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeHidden();
    await expect(page.getByPlaceholder('email', { exact: true })).toHaveValue(account.email);
    // A taken username is refused too.
    await fillSignup(page, randomEmail('dupname'), randomPassword(), undefined, account.username);
    await expect(loginError(page)).toContainText(/username is taken/i);
    // The existing user is untouched and keeps its password.
    const after = await findAuthUserByEmail(account.email);
    expect(after!.id).toBe(before!.id);
    expect(after!.email_verified).toBe(true);
    await expect(signInWithPassword(account.email, account.password)).resolves.toMatchObject({ userId: account.id });
    // And the real owner can still sign straight in.
    expect(await loginAs(page, account)).toBe('directory');
  });

  test('an unverified account cannot sign in until the email is verified; Resend sends a new link', async ({ launchApp, mailpit }) => {
    const email = randomEmail('unconf');
    const password = randomPassword();
    const { page } = await launchApp();
    let userId: string | null = null;
    try {
      await signUpViaUi(page, { email, password });
      userId = (await findAuthUserByEmail(email))!.id;
      await page.getByRole('button', { name: 'Back' }).click();

      // Signing in instead lands back on "Check your email."
      await submitLogin(page, { email, password });
      await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.login-confirm-email')).toHaveText(email);
      expect((await findAuthUserByEmail(email))!.email_verified).toBe(false);

      // Continue before opening the link: still not verified.
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(loginError(page)).toContainText('Not verified yet');

      await mailpit.users.clear(`to:"${email}"`);
      await page.getByRole('button', { name: 'Resend email' }).click();
      await expect(page.getByText(`Sent a new link to ${email}.`)).toBeVisible();

      // Opening the (new) link lifts it; Continue signs in → handle setup.
      expect(await confirmSignup(page, email)).toBe('setup');
      expect((await findAuthUserByEmail(email))!.email_verified).toBe(true);
    } finally {
      if (userId) await deleteAuthUser(userId).catch(() => {});
    }
  });
});

test.describe('sign in', () => {
  test('wrong password and unknown email are refused; the right password then works', async ({ launchApp, account }) => {
    const { page } = await launchApp();

    await submitLogin(page, { email: account.email, password: `${account.password}x` });
    await expect(loginError(page)).toContainText('Wrong username, email or password.');
    await expect(page.locator('.login-recovery')).toBeHidden();

    await submitLogin(page, { email: randomEmail('nobody'), password: randomPassword() });
    await expect(loginError(page)).toContainText('Wrong username, email or password.');

    // By username instead of email.
    expect(await loginAs(page, { email: account.username, password: account.password })).toBe('directory');
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
    backendSql(`UPDATE users SET encrypted_user_secret_recovery = NULL WHERE id = '${account.bosonId}'`);
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
  backendSql(`UPDATE users SET encrypted_user_secret = '\\x0102'::bytea WHERE id = '${account.bosonId}'`);
  const { page } = await launchApp();
  await submitLogin(page, account);
  await expect(loginError(page)).toContainText('Your stored identity key is invalid');
  await page.getByRole('button', { name: 'Start fresh' }).click();

  // DELETE /me ran: the user is new to the backend, so the handle setup shows.
  await expect(page.getByRole('heading', { name: 'Finish setting up your account' })).toBeVisible({ timeout: 30_000 });
  expect(backendSql(`SELECT count(*) FROM users WHERE id = '${account.bosonId}'`)).toBe('0');

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

// "Forgot password?" in the app mails a link to the auth service's reset
// page (on the web); the app then sees a password that no longer opens the
// identity wrap.
test('forgot password: the reset mail sets a new password, and the recovery code re-wraps the identity for it', async ({ launchApp, account, mailpit }) => {
  const first = await launchApp();
  await first.page.getByPlaceholder('username or email', { exact: true }).fill(account.email);
  await first.page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(first.page.getByPlaceholder('email', { exact: true })).toHaveValue(account.email);
  await first.page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(first.page.getByText(/a reset link is on its way/)).toBeVisible();
  await first.app.close();

  // What the reset page does with the link's token.
  const token = await emailToken(account.email, '/reset-password', mailpit.users);
  const newPassword = randomPassword();
  const upd = await authApi('POST', '/v1/password/reset', { token, new_password: newPassword });
  expect(upd.status, JSON.stringify(upd.body)).toBe(200);
  await expect(signInWithPassword(account.email, account.password)).rejects.toThrow();

  const wrapBefore = backendSql(`SELECT encode(encrypted_user_secret, 'base64') FROM users WHERE id = '${account.bosonId}'`);
  const { page } = await launchApp();
  // The old password is gone for good …
  await submitLogin(page, { email: account.email, password: account.password });
  await expect(loginError(page)).toContainText('Wrong username, email or password.');
  // … the new one signs in but needs the recovery code once.
  await submitLogin(page, { email: account.email, password: newPassword });
  await expect(loginError(page)).toContainText('enter your recovery code');
  await recoverWithCode(page, account.recoveryCode!);
  await expect(page.locator('.directory-handle')).toHaveText(`@${account.handle}`);
  await expect.poll(() => backendSql(`SELECT encode(encrypted_user_secret, 'base64') FROM users WHERE id = '${account.bosonId}'`))
    .not.toBe(wrapBefore);

  await signOut(page);
  expect(await loginAs(page, { email: account.email, password: newPassword })).toBe('directory');
});
