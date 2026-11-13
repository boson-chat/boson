// Flow: sign up / sign in via LoginBloc-driven LoginScreen, then the post-signup
// setup prompt (handle + Save), then DirectoryBloc-driven DirectoryScreen
// search/filter and the Sign out button.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginToken, signUpInUi, TEST_PASSWORD } from './auth-helper';

// Each test creates a fresh auth-service user with a unique email so they don't
// collide with each other.
function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@local.dev`;
}


// Registers a unique server via the API so the directory has a known card to
// look for, no matter how much test churn the DB has accumulated.
async function registerServer(request: APIRequestContext, token: string, name: string, description = ''): Promise<void> {
  const res = await request.post('http://localhost:3000/servers', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      hostname: 'irc.example.org',
      port: 6697,
      tls: true,
      name,
      description,
      tags: ['test'],
      languages: ['en'],
    },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe('Auth + directory flow', () => {
  test('sign up, set up handle, see a server we registered', async ({ page, request }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Boson' })).toBeVisible();

    const email = uniqueEmail();
    await signUpInUi(page, request, email);

    // Setup prompt appears after signup since /me 404s.
    await expect(page.getByText('Finish setting up your account')).toBeVisible({ timeout: 10_000 });

    const handle = 'e2e' + Date.now().toString().slice(-6);
    await page.getByPlaceholder('handle').fill(handle);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`@${handle}`)).toBeVisible({ timeout: 10_000 });

    // Register a server via API, then verify it appears in the directory.
    const token = await loginToken(request, email);
    const serverName = `AuthSeed-${Date.now()}`;
    await registerServer(request, token, serverName, 'auth flow seed');

    await page.getByPlaceholder('Search servers…').fill(serverName);
    await expect(page.getByRole('heading', { name: serverName, exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('search filters the directory', async ({ page, request }) => {
    await page.goto('/');

    const email = uniqueEmail('search');
    await signUpInUi(page, request, email);

    await expect(page.getByText('Finish setting up your account')).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('handle').fill('s' + Date.now().toString().slice(-7));
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.directory')).toBeVisible({ timeout: 10_000 });

    // Register two servers with distinct descriptions, then search by description.
    const token = await loginToken(request, email);
    const stamp = Date.now();
    const matchName = `SrchMatch-${stamp}`;
    const otherName = `SrchOther-${stamp}`;
    const uniqueTerm = `unicornz${stamp}`;
    await registerServer(request, token, matchName, `keyword ${uniqueTerm} appears here`);
    await registerServer(request, token, otherName, 'something else entirely');

    await page.getByPlaceholder('Search servers…').fill(uniqueTerm);

    await expect(page.getByRole('heading', { name: matchName, exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('heading', { name: otherName, exact: true })).not.toBeVisible();
  });

  test('sign out returns to the login screen', async ({ page, request }) => {
    await page.goto('/');

    const email = uniqueEmail('signout');
    await signUpInUi(page, request, email);

    await expect(page.getByText('Finish setting up your account')).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder('handle').fill('so' + Date.now().toString().slice(-6));
    await page.getByRole('button', { name: 'Save' }).click();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByPlaceholder('username or email')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Unauthenticated access', () => {
  test('shows the login screen by default', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByPlaceholder('username or email')).toBeVisible();
    await expect(page.getByPlaceholder('password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('bad credentials surface an error', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('username or email').fill('does-not-exist@local.dev');
    await page.getByPlaceholder('password').fill('wrongpass');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Wrong username, email or password.')).toBeVisible({ timeout: 5_000 });
  });
});
