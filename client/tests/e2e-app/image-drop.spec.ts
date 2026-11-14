// Drag and drop onto the image pickers, through a real DataTransfer: the
// profile image in User settings and the server icon in Server settings → Edit.
// A dropped file takes the same path as a chosen one (upload, errors), a
// .txt is rejected inline, and the window drop guard still blocks file drops
// anywhere else.
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, IRC_PORT, STACK, uid, loginAs, serverCard, backendSql, directoryApiAs, seededHostname, type BackendApi,
} from './fixtures';
import { expectConnected, openServerSettings, png, railTile, searchDirectory, settingsTab } from './helpers/directory';

interface DropFile { name: string; mimeType: string; buffer: Buffer }

// Builds a DataTransfer carrying `file` in the page and fires the drag
// sequence at `target`: dragenter, dragover, then (unless `hold`) drop.
async function dragFile(target: Locator, file: DropFile, { hold = false } = {}): Promise<void> {
  const dt = await target.page().evaluateHandle(({ name, mimeType, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], name, { type: mimeType }));
    return data;
  }, { name: file.name, mimeType: file.mimeType, b64: file.buffer.toString('base64') });
  await target.dispatchEvent('dragenter', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  if (!hold) await target.dispatchEvent('drop', { dataTransfer: dt });
}

async function endDrag(target: Locator): Promise<void> {
  const dt = await target.page().evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'x.png', { type: 'image/png' }));
    return data;
  });
  await target.dispatchEvent('dragleave', { dataTransfer: dt });
}

// A file dropped on `selector` (off any picker): the guard must swallow it.
async function strayDropIsBlocked(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'stray.png', { type: 'image/png' }));
    const e = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
    document.querySelector(sel)!.dispatchEvent(e);
    return e.defaultPrevented;
  }, selector);
}

const txt: DropFile = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') };

// Drag-over screenshots, kept with the test's output for review.
async function shot(scope: Page | Locator, name: string): Promise<void> {
  await scope.screenshot({ path: test.info().outputPath(name), animations: 'disabled' });
}

test('drop an image onto the profile picture picker', async ({ launchApp, account, backendApi }) => {
  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  const api = await backendApi(account);

  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await expect(dialog).toBeVisible();
  const picker = dialog.locator('.file-drop').filter({ hasText: 'Profile image' });
  await expect(picker.getByText('or drop an image here')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Upload' })).toHaveAccessibleDescription('or drop an image here');

  // ---- drag-over state ----
  await dragFile(picker, { name: 'red.png', mimeType: 'image/png', buffer: png(32, 32, [220, 30, 30]) }, { hold: true });
  await expect(picker.getByText('Drop to upload')).toBeVisible();
  await shot(dialog, 'avatar-dragover.png');
  await endDrag(picker);
  await expect(picker.getByText('Drop to upload')).toBeHidden();

  // ---- rejected .txt: inline error, nothing uploaded ----
  await dragFile(picker, txt);
  await expect(picker.getByText('Please choose an image file.')).toBeVisible();
  const key = () => backendSql(`SELECT coalesce(avatar_storage_key, '') FROM users WHERE id = '${account.bosonId}'`);
  expect(key()).toBe('');

  // ---- dropped image → uploaded ----
  const url = page.url();
  await dragFile(picker, { name: 'red.png', mimeType: 'image/png', buffer: png(32, 32, [220, 30, 30]) });
  await expect.poll(key, { timeout: 20_000 }).not.toBe('');
  const me = await api.get<{ avatar_url?: string }>('/me');
  expect(me.avatar_url).toMatch(new RegExp(`^${STACK.minio.endpoint}/${STACK.minio.bucket}/.+\\.png$`));
  await expect(dialog.locator('.user-settings-avatar img')).toHaveAttribute('src', me.avatar_url!);
  await expect(page.locator('.title-bar-user-avatar img')).toHaveAttribute('src', me.avatar_url!);
  await expect(picker.getByText('Please choose an image file.')).toBeHidden();
  expect(page.url()).toBe(url); // the drop didn't navigate the window

  // The guard still swallows files dropped anywhere else.
  expect(await strayDropIsBlocked(page, '.user-settings-menu')).toBe(true);
  expect(page.url()).toBe(url);
});

interface ServerRow { id: string; icon_url?: string | null; banner_url?: string | null }
const getRow = async (api: BackendApi, id: string): Promise<ServerRow> =>
  (await api.get<{ network: ServerRow }>(`/v1/networks/${id}`)).network;

test('drop an image onto the server icon picker', async ({ launchApp, account }) => {
  const api = await directoryApiAs(account);
  const name = `Dropped ${uid(8)}`;
  const created = (await api.post<{ network: ServerRow }>('/v1/networks', {
    hostname: seededHostname('owned'), port: IRC_PORT, tls: false, languages: ['en'], name,
  })).network;
  await api.post(`/v1/networks/${created.id}/verify`);

  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  await searchDirectory(page, name);
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page, name);
  const settings = await openServerSettings(page, name);
  await settingsTab(settings, 'Edit').click();

  const icon = settings.locator('.file-drop').filter({ hasText: 'Square. Shown in the directory grid' });
  const banner = settings.locator('.file-drop').filter({ hasText: 'Wide (3:1). Shown atop the listing.' });
  await expect(icon.getByText('or drop an image here')).toBeVisible();

  // ---- drag-over state (icon, then banner) ----
  const red: DropFile = { name: 'icon.png', mimeType: 'image/png', buffer: png(64, 64, [200, 40, 40]) };
  await dragFile(icon, red, { hold: true });
  await expect(icon.getByText('Drop to upload')).toBeVisible();
  await expect(banner.getByText('Drop to upload')).toBeHidden();
  await shot(page, 'server-icon-dragover.png');
  await endDrag(icon);
  await dragFile(banner, red, { hold: true });
  await expect(banner.getByText('Drop to upload')).toBeVisible();
  await shot(page, 'server-banner-dragover.png');
  await endDrag(banner);

  // ---- rejected .txt ----
  await dragFile(icon, txt);
  await expect(icon.getByText('Please choose an image file.')).toBeVisible();
  expect((await getRow(api, created.id)).icon_url ?? null).toBeNull();

  // ---- dropped icon → the directory's media and the rail ----
  await dragFile(icon, red);
  await expect(icon.getByRole('button', { name: 'Change' })).toBeVisible();
  const row = await getRow(api, created.id);
  expect(row.icon_url).toMatch(new RegExp(`^${STACK.directory.url}/media/.+`));
  expect((await fetch(row.icon_url!)).status).toBe(200);
  await expect(railTile(page, name).locator('img.server-item-icon')).toHaveAttribute('src', row.icon_url!);
  expect(row.banner_url ?? null).toBeNull(); // only the picker it was dropped on

  // A file dropped on the chat behind settings is still swallowed.
  expect(await strayDropIsBlocked(page, '.server-settings-menu, nav')).toBe(true);
});

test('drag-over state on the theme picker', async ({ launchApp, account }) => {
  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await dialog.getByRole('tab', { name: /^Appearance/ }).click();
  const picker = dialog.locator('.file-drop').filter({ has: page.getByRole('radiogroup', { name: 'Theme' }) });

  await dragFile(picker, { name: 'sunset.json', mimeType: 'application/json', buffer: Buffer.from('{}') }, { hold: true });
  await expect(picker.getByText('Drop to upload')).toBeVisible();
  await shot(dialog, 'theme-dragover.png');
  await endDrag(picker);

  await dragFile(picker, txt);
  await expect(dialog.getByRole('alert')).toHaveText('That’s not a .json theme file.');

  const theme = JSON.stringify({ name: `Dropped ${uid(4)}`, base: 'light', colors: { accent: '#e8590c' } });
  await dragFile(picker, { name: 'dropped.json', mimeType: 'application/json', buffer: Buffer.from(theme) });
  await expect(dialog.getByRole('status')).toContainText('Imported "Dropped');
  await expect(dialog.getByRole('radio', { name: /^Dropped/ })).toHaveAttribute('aria-checked', 'true');
});
