// File and image uploads to a network's files host (boson-chat/files), here
// a fake one (helpers/files-server.ts) named by the network's boson.json
// (BOSON_NETWORK_JSON, dev builds). The shell discovers it, holds the
// allowlist and streams uploads and previews (desktop/files.go).
//
// Proves: a file dragged onto the conversation opens the upload sheet
// (drop overlay first); renaming it keeps the extension; Send uploads it
// as the network account (Bearer) and posts the link, which renders inline
// (image thumbnail from a blob: URL, lightbox; a file card with size,
// expiry and download; "File expired" once gone). A quota refusal reads
// "You've used … in the last 3 days, 1 GB frees up in 20 h". A guest gets
// a guest token on the first upload (and a pasted file works too). No
// attach button where uploads aren't available.
import type { Locator, Page } from '@playwright/test';
import {
  test, expect, STACK, IRC_HOST, IRC_PORT, addServerManually, continueAsGuest, joinChannel, randomChannel,
  randomEmail, randomPassword, randomUsername, serverCard, uid,
  IMG,
} from './fixtures';
import { expectConnected, png } from './helpers/directory';
import { filesNetworkJson, startFakeFiles, type FakeFiles } from './helpers/files-server';

const NET = STACK.selfhost;
const SHOTS = process.env['FILES_SHOTS_DIR'] ?? '';

interface DropFile { name: string; mimeType: string; buffer: Buffer }

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

async function shot(scope: Page | Locator, name: string): Promise<void> {
  const path = SHOTS ? `${SHOTS}/${name}` : test.info().outputPath(name);
  await scope.screenshot({ path, animations: 'disabled' });
}

async function registerOnNetwork(): Promise<{ username: string; password: string }> {
  const username = randomUsername('fup');
  const password = randomPassword();
  const res = await fetch(`${NET.auth.url}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: randomEmail('fup'), password }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return { username, password };
}

const attach = (page: Page): Locator => page.getByRole('button', { name: 'Attach files' });
const sheet = (page: Page): Locator => page.getByRole('dialog', { name: /^Upload (\d+ files )?to / });
const conversationArea = (page: Page): Locator => page.locator('main .chat-messages');

// Guest, on the e2e ergo (127.0.0.1) whose boson.json names the main auth
// service and `files`.
type Launch = (opts?: { env?: Record<string, string> }) => Promise<{ page: Page }>;

async function guestOnFilesNetwork(launchApp: Launch, files: FakeFiles | null): Promise<{ page: Page; channel: string }> {
  const env: Record<string, string> = files ? { BOSON_NETWORK_JSON: filesNetworkJson({ host: IRC_HOST, port: IRC_PORT }, STACK.auth.url, files.url) } : {};
  const { page } = await launchApp({ env });
  await continueAsGuest(page, `g${uid()}`);
  const name = `Files ${uid()}`;
  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name, tls: false });
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page, name);
  const channel = randomChannel('fup');
  await joinChannel(page, channel);
  return { page, channel };
}

test.describe('file uploads', () => {
  let files: FakeFiles;
  test.afterEach(async () => { await files?.close(); });

  test('drag an image in, rename it, send: the link renders inline; a file card; expired', async ({ launchApp }) => {
    test.setTimeout(180_000);
    files = await startFakeFiles();
    const user = await registerOnNetwork();
    const name = `Files net ${uid()}`;
    const { page } = await launchApp({ env: { BOSON_NETWORK_JSON: filesNetworkJson(NET.irc, NET.auth.url, files.url) } });
    await continueAsGuest(page, `g${uid()}`);
    await addServerManually(page, { hostname: NET.irc.host, port: NET.irc.port, name, tls: false });
    await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: `Sign in to ${name}` });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByPlaceholder('username or email', { exact: true }).fill(user.username);
    await dialog.getByPlaceholder('password', { exact: true }).fill(user.password);
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expectConnected(page, name);
    const channel = randomChannel('fup');
    await joinChannel(page, channel);
    await expect(attach(page)).toBeVisible({ timeout: 15_000 });

    // Drag over the conversation: the drop overlay.
    const image = { name: 'IMG_0042.png', mimeType: 'image/png', buffer: png(320, 200, [40, 140, 220]) };
    await dragFile(conversationArea(page), image, { hold: true });
    await expect(page.getByTestId('chat-drop-overlay')).toBeVisible();
    await expect(page.getByTestId('chat-drop-overlay')).toContainText(`Drop files to upload to ${channel}`);
    await shot(page, 'files-drop-overlay.png');
    await conversationArea(page).dispatchEvent('drop', {
      dataTransfer: await page.evaluateHandle(({ b64 }) => {
        const d = new DataTransfer();
        d.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'IMG_0042.png', { type: 'image/png' }));
        return d;
      }, { b64: image.buffer.toString('base64') }),
    });

    // The sheet: thumbnail, size, filename (stem selected), caption, usage.
    const s = sheet(page);
    await expect(s).toBeVisible();
    await expect(page.getByTestId('chat-drop-overlay')).toBeHidden();
    const nameField = s.getByLabel('Filename for IMG_0042.png');
    await expect(nameField).toHaveValue('IMG_0042.png');
    await expect(s.locator('.upload-sheet-thumb img')).toHaveAttribute('src', /^blob:/);
    await expect(s.getByTestId('upload-usage')).toContainText('1.2 GB of 5 GB used · 1 GB frees in 20 h');
    // Typing replaces the selected stem; the extension stays.
    await nameField.press('Control+a');
    await nameField.fill('sunset at the bay');
    await expect(s).toContainText('Uploads as sunset at the bay.png');
    await s.getByLabel('Caption for IMG_0042.png').fill('Tonight');
    await shot(s, 'files-upload-sheet.png');
    await s.getByLabel('Caption for IMG_0042.png').press('Enter');
    await expect(s).toBeHidden();

    // Uploaded as the network account, under the new name; the link posted.
    await expect.poll(() => files.files.length, { timeout: 20_000 }).toBe(1);
    const up = files.files[0]!;
    expect(up.name).toBe('sunset at the bay.png');
    expect(up.auth).toMatch(/^Bearer /);
    expect(up.body.equals(image.buffer)).toBe(true);
    expect(files.guestTokens).toBe(0);
    const url = `${files.url}/f/${up.id}/sunset%20at%20the%20bay.png`;
    await expect(page.locator('.message-row-text').filter({ hasText: `Tonight ${url}` })).toBeVisible({ timeout: 15_000 });
    const embed = page.locator('[data-testid="files-embed"][data-media="image"]');
    await expect(embed.locator('img')).toHaveAttribute('src', IMG.file, { timeout: 15_000 });
    await expect.poll(() => embed.locator('img').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(320);
    await embed.getByRole('button', { name: 'Open sunset at the bay.png' }).click();
    await expect(page.locator('.embed-lightbox img')).toHaveAttribute('src', IMG.file);
    await page.keyboard.press('Escape');
    await expect(page.locator('.embed-lightbox')).toBeHidden();

    // Any other file, through the attach button: a file card.
    await page.getByTestId('attach-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('meeting notes\n'.repeat(100)) });
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => files.files.length, { timeout: 20_000 }).toBe(2);
    const card = page.locator('[data-testid="files-embed"][data-media="file"]');
    await expect(card).toContainText('notes.txt');
    await expect(card).toContainText('1.4 KB · expires in 2 days');
    await expect(card.getByRole('button', { name: 'Download notes.txt' })).toBeVisible();
    await shot(page.locator('main .chat-messages'), 'files-inline-cards.png');

    // Gone from the files host: a new mention of it says so.
    files.expire(files.files[1]!.id);
    const txtUrl = `${files.url}/f/${files.files[1]!.id}/notes.txt`;
    await page.getByPlaceholder(new RegExp(`^Message ${channel}$`)).fill(`again: ${txtUrl}`);
    await page.getByPlaceholder(new RegExp(`^Message ${channel}$`)).press('Enter');
    await expect(page.locator('[data-testid="files-embed"][data-state="expired"]')).toContainText('File expired', { timeout: 15_000 });
    await shot(page.locator('main .chat-messages'), 'files-inline-expired.png');
  });

  test('over quota: the upload fails with when space frees up', async ({ launchApp }) => {
    test.setTimeout(120_000);
    files = await startFakeFiles({ used: 4.8e9, refuse: 'quota_exceeded' });
    const { page } = await guestOnFilesNetwork(launchApp, files);
    await expect(attach(page)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('attach-input').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(4096, 1) });
    await expect(sheet(page).getByTestId('upload-usage')).toContainText('4.8 GB of 5 GB used');
    await sheet(page).getByRole('button', { name: 'Send' }).click();
    const row = page.getByTestId('upload-row');
    await expect(row.getByRole('alert')).toHaveText("You've used 4.8 GB of 5 GB in the last 3 days, 1 GB frees up in 20 h", { timeout: 15_000 });
    await shot(page, 'files-quota-exceeded.png');
    expect(files.files).toHaveLength(0);
    await row.getByRole('button', { name: 'Dismiss clip.mp4' }).click();
    await expect(row).toHaveCount(0);
  });

  test('a guest gets a guest token on the first upload; a pasted image works', async ({ launchApp }) => {
    test.setTimeout(120_000);
    files = await startFakeFiles();
    const { page, channel } = await guestOnFilesNetwork(launchApp, files);
    await expect(attach(page)).toBeVisible({ timeout: 15_000 });
    expect(files.guestTokens).toBe(0);

    // Paste an image into the composer.
    const box = page.getByPlaceholder(new RegExp(`^Message ${channel}$`));
    await box.focus();
    await box.evaluate((el, b64) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
      // Firefox ignores clipboardData in the ClipboardEvent constructor (an
      // empty one):
      // give the event its data the way a real paste carries it.
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: data });
      el.dispatchEvent(ev);
    }, png(64, 64, [200, 60, 60]).toString('base64'));
    await expect(sheet(page)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => files.files.length, { timeout: 20_000 }).toBe(1);
    expect(files.files[0]!.auth).toMatch(/^Guest guest-1-/);
    expect(files.guestTokens).toBe(1);
    await expect(page.locator('[data-testid="files-embed"][data-media="image"] img')).toHaveAttribute('src', IMG.file, { timeout: 15_000 });

    // A second upload reuses the token.
    await page.getByTestId('attach-input').setInputFiles({ name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('b') });
    await sheet(page).getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => files.files.length, { timeout: 20_000 }).toBe(2);
    expect(files.guestTokens).toBe(1);
  });

  test('several files: drop 3, remove one, add a caption, send: posted in the listed order', async ({ launchApp }) => {
    test.setTimeout(120_000);
    files = await startFakeFiles();
    const { page, channel } = await guestOnFilesNetwork(launchApp, files);
    await expect(attach(page)).toBeVisible({ timeout: 15_000 });
    // The first file is the biggest, so it finishes last: the order posted
    // is the sheet's, not the finish order.
    const dropped = [
      { name: 'first.bin', type: 'application/octet-stream', b64: Buffer.alloc(3_000_000, 7).toString('base64') },
      { name: 'second.txt', type: 'text/plain', b64: Buffer.from('two').toString('base64') },
      { name: 'third.txt', type: 'text/plain', b64: Buffer.from('three').toString('base64') },
    ];
    await conversationArea(page).dispatchEvent('drop', {
      dataTransfer: await page.evaluateHandle((list) => {
        const d = new DataTransfer();
        for (const f of list) d.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
        return d;
      }, dropped),
    });
    const s = sheet(page);
    await expect(page.getByRole('dialog', { name: `Upload 3 files to ${channel}` })).toBeVisible();
    await expect(s.getByTestId('upload-item')).toHaveCount(3);
    await expect(s.getByTestId('upload-total')).toHaveText('3 files · 3 MB');
    await s.getByRole('button', { name: 'Remove second.txt' }).click();
    await expect(page.getByRole('dialog', { name: `Upload 2 files to ${channel}` })).toBeVisible();
    await expect(s.getByTestId('upload-item')).toHaveCount(2);
    await s.getByLabel('Caption for these files').fill('two files');
    await shot(s, 'files-upload-batch-sheet.png');
    await s.getByRole('button', { name: 'Send 2 files' }).click();
    await expect(s).toBeHidden();

    await expect.poll(() => files.files.length, { timeout: 20_000 }).toBe(2);
    expect(files.files.map((f) => f.name).sort()).toEqual(['first.bin', 'third.txt']);
    const link = (name: string) => `${files.url}/f/${files.files.find((f) => f.name === name)!.id}/${name}`;
    // The caption, then both links in one message (they fit one line), in
    // the sheet's order.
    const rows = page.locator('.message-row-mine .message-row-text-body');
    await expect(rows.filter({ hasText: link('third.txt') })).toHaveText(`${link('first.bin')} ${link('third.txt')}`, { timeout: 15_000 });
    const texts = await rows.allTextContents();
    const at = texts.findIndex((t) => t === 'two files');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(texts[at + 1]).toBe(`${link('first.bin')} ${link('third.txt')}`);
  });

  test('no attach button where uploads are off', async ({ launchApp }) => {
    test.setTimeout(120_000);
    // Guest uploads turned off on the network's files host.
    files = await startFakeFiles({ guestEnabled: false });
    const { page } = await guestOnFilesNetwork(launchApp, files);
    // Discovery and config ran…
    await expect.poll(() => files.requests.some((r) => r.path === '/v1/config'), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(500);
    // …and there's no attach, and a dropped file does nothing.
    await expect(attach(page)).toHaveCount(0);
    await dragFile(conversationArea(page), { name: 'x.png', mimeType: 'image/png', buffer: png(8, 8, [0, 0, 0]) }, { hold: true });
    await expect(page.getByTestId('chat-drop-overlay')).toHaveCount(0);
    await expect(sheet(page)).toHaveCount(0);
    expect(files.guestTokens).toBe(0);
  });

  test('no attach button on a network without a files host', async ({ launchApp }) => {
    test.setTimeout(120_000);
    const { page } = await guestOnFilesNetwork(launchApp, null);
    await page.waitForTimeout(1500);
    await expect(attach(page)).toHaveCount(0);
  });
});
