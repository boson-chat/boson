// UI flows for account (signed-in) mode, against the e2e stack.
//
//   signUpViaUi          Login screen → Signup tab → "Check your email."
//   confirmSignup        confirmation mail → GoTrue /verify → the
//                        boson://auth/confirmed deep link the website's
//                        /auth/confirmed page would hand the OS → the app
//   loginAs              Login tab → email + password → Sign in (unlocks
//                        the identity with the password); submitLogin
//                        just submits (for expected failures)
//   completeHandleSetup  first-sign-in "Finish setting up your account" →
//                        recovery code reveal → directory
//   recoverWithCode      the recovery-code unlock offered when the password
//                        no longer decrypts the identity
//   signOut              directory top bar → Sign out
import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { Mailpit, extractLinks } from './mailpit';

export interface Credentials {
  email: string;
  password: string;
}

const loginScreen = (page: Page) => page.locator('.login-screen');
const setupHeading = (page: Page) => page.getByRole('heading', { name: 'Finish setting up your account' });
const directoryHeading = (page: Page) => page.getByRole('heading', { name: 'Server Directory' });

export async function signUpViaUi(page: Page, c: Credentials): Promise<void> {
  await page.getByRole('tab', { name: 'Signup' }).click();
  await page.getByPlaceholder('email', { exact: true }).fill(c.email);
  await page.getByPlaceholder('password', { exact: true }).fill(c.password);
  await page.getByPlaceholder('confirm password').fill(c.password);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.login-confirm-email')).toHaveText(c.email);
}

// Hands a boson:// URL to the running app the way the OS would: `open-url`
// on macOS, a second-instance launch (argv) on Windows/Linux. Both land in
// the main process's dispatchDeepLink.
export async function deliverDeepLink(app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, { url: u, platform }) => {
    if (platform === 'darwin') {
      electronApp.emit('open-url', { preventDefault: () => {} }, u);
    } else {
      electronApp.emit('second-instance', { preventDefault: () => {} }, [process.execPath, u], process.cwd(), {});
    }
  }, { url, platform: process.platform });
}

// What the user's click on the confirmation link ends up as: GoTrue verifies
// the token and 302s to the marketing site's /auth/confirmed page with the
// session in the fragment; that page (website/src/pages/AuthConfirmedPage.tsx)
// merges fragment + query into boson://auth/confirmed?… . Returns that URL.
export async function confirmationDeepLink(email: string, mail = Mailpit.users()): Promise<string> {
  const msg = await mail.waitFor({ to: email, subject: 'Confirm your email' });
  const link = extractLinks(msg).find((l) => l.includes('/auth/v1/verify'));
  if (!link) throw new Error(`no /verify link in the confirmation mail to ${email}:\n${msg.Text}`);
  const res = await fetch(link, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (res.status !== 303 && res.status !== 302 && res.status !== 301) {
    throw new Error(`/verify answered ${res.status} (expected a redirect): ${await res.text()}`);
  }
  if (!location) throw new Error('/verify redirect without a Location');
  const landing = new URL(location);
  if (landing.origin !== 'https://boson.chat' || landing.pathname !== '/auth/confirmed') {
    throw new Error(`/verify redirected to ${landing.origin}${landing.pathname}, not the website's /auth/confirmed — is it allow-listed in infra/e2e/supabase/config.toml?`);
  }
  const merged = new URLSearchParams();
  new URLSearchParams(landing.hash.replace(/^#/, '')).forEach((v, k) => merged.set(k, v));
  landing.searchParams.forEach((v, k) => merged.set(k, v));
  if (merged.has('error')) throw new Error(`confirmation failed: ${merged.get('error_description') ?? merged.get('error')}`);
  return `boson://auth/confirmed?${merged.toString()}`;
}

// Confirmation mail → deep link → app. The app then holds a session but no
// unlocked identity, so it shows the login screen again: follow with
// loginAs().
export async function confirmSignup(app: ElectronApplication, email: string): Promise<void> {
  await deliverDeepLink(app, await confirmationDeepLink(email));
}

// Fills + submits the login form without waiting for the outcome (for
// specs that expect a failure). Most specs want loginAs().
export async function submitLogin(page: Page, c: Credentials): Promise<void> {
  await page.getByRole('tab', { name: 'Login' }).click();
  await page.getByPlaceholder('email', { exact: true }).fill(c.email);
  await page.getByPlaceholder('password', { exact: true }).fill(c.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

// Signs in on the login screen. Resolves once the app left it: on the
// first-sign-in handle setup (no /me yet) or the directory.
export async function loginAs(page: Page, c: Credentials): Promise<'setup' | 'directory'> {
  await submitLogin(page, c);
  const setup = setupHeading(page);
  const directory = directoryHeading(page);
  await expect(setup.or(directory).or(page.locator('.login-error'))).toBeVisible({ timeout: 30_000 });
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
