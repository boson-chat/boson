// UI flows for account (signed-in) mode, against the e2e stack.
//
//   signUpViaUi          Login screen → Signup tab → "Check your email."
//   confirmSignup        verification mail → the auth service verifies (what
//                        its /verify-email page does when the link is
//                        opened) → Continue on "Check your email."
//   loginAs              Login tab → email + password → Sign in (unlocks
//                        the identity with the password); submitLogin
//                        just submits (for expected failures)
//   completeHandleSetup  first-sign-in "Finish setting up your account" →
//                        recovery code reveal → directory
//   recoverWithCode      the recovery-code unlock offered when the password
//                        no longer decrypts the identity
//   signOut              directory top bar → Sign out
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { secondInstance, type App } from '../desktop-app';
import { randomUsername, verifyEmail } from './auth';

export interface Credentials {
  email: string;
  password: string;
  // Sign-up only (a random one when omitted).
  username?: string;
}

const loginScreen = (page: Page) => page.locator('.login-screen');
const setupHeading = (page: Page) => page.getByRole('heading', { name: 'Finish setting up your account' });
const directoryHeading = (page: Page) => page.getByRole('heading', { name: 'Server Directory' });

export async function signUpViaUi(page: Page, c: Credentials): Promise<string> {
  const username = c.username ?? randomUsername('signup');
  await page.getByRole('tab', { name: 'Signup' }).click();
  await page.getByPlaceholder('username', { exact: true }).fill(username);
  await page.getByPlaceholder('email', { exact: true }).fill(c.email);
  await page.getByPlaceholder('password', { exact: true }).fill(c.password);
  await page.getByPlaceholder('confirm password').fill(c.password);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.login-confirm-email')).toHaveText(c.email);
  return username;
}

// Hands a boson:// URL to the running app the way the OS would on
// Windows/Linux: a second launch with the URL in argv (desktop/deeplink.go;
// macOS's open-url event ends up in the same place).
export function deliverDeepLink(app: App, url: string): Promise<void> {
  return secondInstance(app, [url]);
}

// The user opens the verification link (the auth service's page verifies
// the token), comes back and presses Continue: the app signs in with what
// was typed at sign-up. Resolves like loginAs().
export async function confirmSignup(page: Page, email: string): Promise<'setup' | 'directory'> {
  await verifyEmail(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  return waitSignedIn(page);
}

// Fills + submits the login form without waiting for the outcome (for
// specs that expect a failure). Most specs want loginAs().
export async function submitLogin(page: Page, c: Credentials): Promise<void> {
  await page.getByRole('tab', { name: 'Login' }).click();
  await page.getByPlaceholder('username or email', { exact: true }).fill(c.email);
  await page.getByPlaceholder('password', { exact: true }).fill(c.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

// Signs in on the login screen. Resolves once the app left it: on the
// first-sign-in handle setup (no /me yet) → 'setup', otherwise 'directory',
// meaning "signed in, past setup": the directory, OR the chat view when a
// synced session restores straight into it (a second device can win that
// race against the directory's first paint, as it does on Linux CI).
export async function loginAs(page: Page, c: Credentials): Promise<'setup' | 'directory'> {
  await submitLogin(page, c);
  return waitSignedIn(page);
}

async function waitSignedIn(page: Page): Promise<'setup' | 'directory'> {
  const setup = setupHeading(page);
  const directory = directoryHeading(page);
  const restoredChat = page.getByRole('navigation', { name: 'Servers' });
  await expect(setup.or(directory).or(restoredChat).or(page.locator('.login-error'))).toBeVisible({ timeout: 30_000 });
  const err = page.locator('.login-error');
  if (await err.isVisible()) throw new Error(`sign-in failed: ${await err.innerText()}`);
  return (await setup.isVisible()) ? 'setup' : 'directory';
}

// First sign-in: pick a handle, acknowledge the recovery code. Returns the
// code (the only way back in after a password reset).
export async function completeHandleSetup(page: Page, handle: string): Promise<string> {
  await expect(setupHeading(page)).toBeVisible();
  await page.getByPlaceholder('handle', { exact: true }).fill(handle);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const code = page.getByLabel('recovery code', { exact: true });
  await expect(code).toBeVisible({ timeout: 20_000 });
  const recoveryCode = (await code.innerText()).trim();
  await page.getByText('I’ve saved my recovery code somewhere safe.').click();
  await page.locator('.recovery-code-reveal').getByRole('button').last().click();
  await expect(directoryHeading(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.directory-handle')).toHaveText(`@${handle}`);
  return recoveryCode;
}

// After a password unlock failed but the account has a recovery wrap, the
// login screen offers a recovery-code field. Unlocks + re-wraps under the
// password just typed.
export async function recoverWithCode(page: Page, recoveryCode: string): Promise<void> {
  await page.getByPlaceholder('xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx').fill(recoveryCode);
  await page.getByRole('button', { name: 'Recover with code' }).click();
  await expect(loginScreen(page)).toBeHidden({ timeout: 30_000 });
}

export async function signOut(page: Page): Promise<void> {
  await page.locator('.directory-topbar').getByRole('button', { name: 'Sign out' }).click();
  await expect(loginScreen(page)).toBeVisible({ timeout: 20_000 });
}
