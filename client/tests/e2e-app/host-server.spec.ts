// "Add your server to the community" (HostServerModal + ServerHostingBloc)
// against the real backend: register a server through the UI, get the DNS
// TXT instructions with the backend's token, verify (the e2e backend runs
// with SKIP_DNS_VERIFY, so any verify of a live token succeeds), see it in
// the public directory — plus the pending / lapsed list states, an expired
// token (410) → Regenerate token, and the 30s verify rate limit (429).
import type { Page } from '@playwright/test';
import {
  test, expect, IRC_PORT, uid, field, loginAs, serverCard, backendSql,
} from './fixtures';
import { searchDirectory } from './helpers/directory';

interface OwnerServer {
  id: string;
  name: string;
  hostname: string;
  verification_status: string;
  verification_token?: string;
  tags: string[];
  languages: string[];
  is_nsfw: boolean;
  description?: string | null;
}

async function openHostModal(page: Page) {
  await page.getByRole('button', { name: 'Add your server to the community' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add your server to the directory' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('register a server through the UI, verify it, and find it in the directory', async ({ launchApp, account, backendApi }) => {
  const api = await backendApi(account);
  const name = `Hosted ${uid(8)}`;
  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');

  const dialog = await openHostModal(page);
  await expect(dialog.getByText('No servers registered yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add a server' }).click();

  // Cancel goes back to the (still empty) list.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByText('No servers registered yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add a server' }).click();

  await field(dialog, 'Display name').fill(name);
  await field(dialog, 'Hostname').fill('LocalHost');
  await field(dialog, 'Port').fill('0');
  await field(dialog, 'Description').fill(`A test community ${name}`);
  const tags = dialog.getByRole('textbox', { name: 'Tags' });
  await tags.fill('#FOSS');
  await tags.press('Enter');
  await tags.fill('chat,e2e');
  await tags.press('Enter');
  await expect(dialog.locator('.bds-chip-text')).toHaveText(['foss', 'chat', 'e2e']);
  await dialog.getByRole('button', { name: 'Remove e2e' }).click();

  // Client-side validation before anything reaches the backend.
  await dialog.getByRole('button', { name: 'Register' }).click();
  await expect(dialog.getByText('Port must be a number between 1 and 65535.')).toBeVisible();
  await field(dialog, 'Port').fill(String(IRC_PORT));
  await dialog.getByRole('button', { name: 'Register' }).click();
  await expect(dialog.getByText('Pick at least one language so the directory filter has something to match.')).toBeVisible();
  expect((await api.get<{ servers: OwnerServer[] }>('/servers/me')).servers).toHaveLength(0);

  const langs = dialog.getByRole('textbox', { name: 'Languages' });
  await langs.fill('english'); // not an ISO code: silently rejected
  await langs.press('Enter');
  await langs.fill('en');
  await langs.press('Enter');
  await expect(dialog.locator('.bds-chip-text')).toHaveText(['foss', 'chat', 'en']);
  await dialog.getByText('TLS (recommended)', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Register' }).click();

  // Verify view: the TXT record carries the backend's token for this row.
  await expect(dialog.locator('.server-hosting-verify-head')).toContainText(name);
  await expect(dialog.locator('.server-hosting-verify-head')).toContainText(`localhost:${IRC_PORT}`);
  await expect(dialog.locator('.server-hosting-verify-head')).not.toContainText('(TLS)');
  await expect(dialog.locator('.server-hosting-verify-head')).toContainText('Pending');
  const [mine] = (await api.get<{ servers: OwnerServer[] }>('/servers/me')).servers;
  expect(mine).toMatchObject({
    name, hostname: 'localhost', verification_status: 'pending',
    tags: ['foss', 'chat'], languages: ['en'], is_nsfw: false, description: `A test community ${name}`,
  });
  expect(mine!.verification_token).toBeTruthy();
  await expect(dialog.locator('.server-hosting-record')).toHaveText(
    `_boson.localhost.  300  IN  TXT  "boson-verify=${mine!.verification_token}"`,
  );
  await expect(dialog.getByText(`dig +short TXT _boson.localhost @1.1.1.1`)).toBeVisible();

  await dialog.getByRole('button', { name: 'Verify now' }).click();
  await expect(dialog.getByText('Verified. Your server is live on the directory.')).toBeVisible();
  await expect(dialog.locator('.server-hosting-verify-head')).toContainText('Verified');
  expect((await api.get<OwnerServer>(`/servers/${mine!.id}`)).verification_status).toBe('verified');

  // Back to the list: the row is verified, nothing left to continue.
  await dialog.getByRole('button', { name: 'Back to list' }).click();
  const row = dialog.locator('.server-hosting-row').filter({ hasText: name });
  await expect(row).toContainText('Verified');
  await expect(row.getByRole('button', { name: 'Continue verification' })).toHaveCount(0);

  // Closing the modal refetches the directory: the new listing is there.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await searchDirectory(page, name);
  const card = serverCard(page, name);
  await expect(card).toBeVisible();
  await expect(card.locator('.directory-card-tag')).toHaveText(['VERIFIED', 'FOSS', 'CHAT']);
  await expect(card.locator('.directory-card-host')).toHaveText(`localhost:${IRC_PORT}`);
});

test('pending and lapsed rows; expired token → regenerate; verify rate limit', async ({ launchApp, account, backendApi }) => {
  const api = await backendApi(account);
  const register = (name: string): Promise<OwnerServer & { verification_token: string }> =>
    api.post('/servers', { hostname: 'localhost', port: IRC_PORT, tls: false, name, languages: ['en'] });
  const fresh = await register(`Fresh ${uid(8)}`);
  const expired = await register(`Expired ${uid(8)}`);
  const lapsed = await register(`Lapsed ${uid(8)}`);
  await api.post(`/servers/${lapsed.id}/verify`);
  backendSql(`UPDATE servers SET verification_status = 'lapsed' WHERE id = '${lapsed.id}'`);
  backendSql(`UPDATE servers SET verification_token_issued_at = now() - interval '4 days' WHERE id = '${expired.id}'`);

  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  const dialog = await openHostModal(page);
  const row = (name: string) => dialog.locator('.server-hosting-row').filter({ hasText: name });
  await expect(row(fresh.name)).toContainText('Pending');
  await expect(row(expired.name)).toContainText('Pending');
  await expect(row(lapsed.name)).toContainText('Lapsed');
  await expect(row(lapsed.name).getByRole('button', { name: 'Continue verification' })).toHaveCount(0);
  // Lapsed / pending rows aren't in the public directory.
  const listed = (await api.get<{ servers: OwnerServer[] }>(`/servers?q=${encodeURIComponent(lapsed.name)}`)).servers;
  expect(listed.map((s) => s.id)).not.toContain(lapsed.id);

  // Expired token: the backend answers 410; the UI offers a new token.
  await row(expired.name).getByRole('button', { name: 'Continue verification' }).click();
  await expect(dialog.locator('.server-hosting-record')).toContainText(expired.verification_token);
  await dialog.getByRole('button', { name: 'Verify now' }).click();
  await expect(dialog.getByText(/This token expired \(72h limit\)/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Regenerate token' }).click();
  await expect(dialog.getByText(/This token expired/)).toBeHidden();
  await expect(dialog.locator('.server-hosting-record')).not.toContainText(expired.verification_token);
  const regenerated = (await api.get<{ servers: OwnerServer[] }>('/servers/me')).servers.find((s) => s.id === expired.id)!;
  expect(regenerated.verification_token).toBeTruthy();
  expect(regenerated.verification_token).not.toBe(expired.verification_token);
  await expect(dialog.locator('.server-hosting-record')).toContainText(`boson-verify=${regenerated.verification_token}`);

  // A second verify inside the 30s window is rate-limited (429): the button
  // counts down instead of hammering the resolvers.
  await dialog.getByRole('button', { name: 'Verify now' }).click();
  await expect(dialog.getByText('Slow down — at most one verify every 30 seconds.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Retry in \d+s$/ })).toBeDisabled();
  expect((await api.get<OwnerServer>(`/servers/${expired.id}`)).verification_status).toBe('pending');

  // The fresh row verifies on the first try.
  await dialog.getByRole('button', { name: 'Back to list' }).click();
  await row(fresh.name).getByRole('button', { name: 'Continue verification' }).click();
  await expect(dialog.locator('.server-hosting-record')).toContainText(fresh.verification_token);
  await dialog.getByRole('button', { name: 'Verify now' }).click();
  await expect(dialog.getByText('Verified. Your server is live on the directory.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Back to list' }).click();
  await expect(row(fresh.name)).toContainText('Verified');
});
