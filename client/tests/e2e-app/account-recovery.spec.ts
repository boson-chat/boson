// Account lifecycle beyond the first sign-in: sign out → the password is
// reset → the old identity wrap no longer opens with the new password → the
// recovery code unlocks it and re-wraps it, so the new password works from
// then on.
import {
  test, expect, backendSql, loginAs, randomPassword, recoverWithCode, setAuthPassword, signOut, submitLogin,
} from './fixtures';

test('after a password reset the recovery code unlocks the identity and re-wraps it', async ({ launchApp, account }) => {
  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  const wrapBefore = backendSql(`SELECT encode(encrypted_user_secret, 'base64') FROM users WHERE id = '${account.id}'`);
  expect(wrapBefore.length).toBeGreaterThan(40);

  await signOut(page);
  const newPassword = randomPassword();
  await setAuthPassword(account.id, newPassword);

  // The new password signs in to Supabase but can't decrypt the identity.
  await submitLogin(page, { email: account.email, password: newPassword });
  await expect(page.locator('.login-error')).toContainText('enter your recovery code');
  await recoverWithCode(page, account.recoveryCode!);
  await expect(page.locator('.directory-handle')).toHaveText(`@${account.handle}`);

  // Re-wrapped under the new password on the backend …
  await expect.poll(() => backendSql(`SELECT encode(encrypted_user_secret, 'base64') FROM users WHERE id = '${account.id}'`))
    .not.toBe(wrapBefore);
  // … so the next sign-in needs no recovery code.
  await signOut(page);
  expect(await loginAs(page, { email: account.email, password: newPassword })).toBe('directory');
});
