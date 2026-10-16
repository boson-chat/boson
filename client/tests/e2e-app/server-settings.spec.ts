// Server settings (right-click a server-rail tile → "Server details") for a
// directory server the signed-in user owns: the Info panel from the IRCv3
// handshake, the owner-only Edit tab (profile fields → PATCH /servers/{id};
// icon/banner → backend → MinIO, and removal), Operators, the engine Log,
// and the Actions section (Reconnect / Disconnect). Plus: a non-owner gets
// no owner tabs.
import {
  test, expect, IRC_HOST, IRC_PORT, STACK, uid, loginAs, serverCard, joinChannel, randomChannel,
  continueAsGuest, seedServer, randomNick,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import {
  expectConnected, openServerSettings, png, railTile, searchDirectory, settingsTab,
} from './helpers/directory';

interface ServerRow {
  id: string;
  name: string;
  description?: string | null;
  tags: string[];
  languages: string[];
  is_nsfw: boolean;
  icon_url?: string | null;
  banner_url?: string | null;
}

test('owner edits the directory profile and images from Server settings', async ({ launchApp, account, backendApi }) => {
  const api = await backendApi(account);
  const name = `Owned ${uid(8)}`;
  const created = await api.post<ServerRow>('/servers', {
    hostname: 'localhost', port: IRC_PORT, tls: false, name,
    description: 'Before', tags: ['alpha', 'beta'], languages: ['en'],
  });
  await api.post(`/servers/${created.id}/verify`);

  const { page } = await launchApp();
  expect(await loginAs(page, account)).toBe('directory');
  await searchDirectory(page, name);
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page, name);

  const settings = await openServerSettings(page, name);
  await expect(settingsTab(settings, 'Edit')).toBeVisible();
  await expect(settingsTab(settings, 'Operators')).toBeVisible();

  // ---- profile fields ----
  await settingsTab(settings, 'Edit').click();
  await expect(settings.getByRole('heading', { name: 'Directory profile' })).toBeVisible();
  const save = settings.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled(); // nothing changed yet
  const renamed = `${name} renamed`;
  const nameInput = settings.locator('.bds-field').filter({ hasText: 'What users see in the directory grid.' }).locator('input');
  await expect(nameInput).toHaveValue(name);
  await nameInput.fill(renamed);
  await settings.locator('textarea.server-settings-textarea').fill('After the edit');
  await settings.getByRole('button', { name: 'Remove alpha' }).click();
  const tags = settings.getByRole('textbox', { name: 'Tags' });
  await tags.fill('gamma');
  await tags.press('Enter');
  const langs = settings.getByRole('textbox', { name: 'Languages' });
  await langs.fill('fr');
  await langs.press('Enter');
  await settings.getByText('NSFW — hidden from default search', { exact: true }).click();
  await save.click();
  await expect(settings.getByText('Saved', { exact: true })).toBeVisible();

  await expect.poll(async () => api.get<ServerRow>(`/servers/${created.id}`)).toMatchObject({
    name: renamed, description: 'After the edit', tags: ['beta', 'gamma'], languages: ['en', 'fr'], is_nsfw: true,
  });
  // The page header and the rail pick the new name up without a refetch.
  await expect(settings.locator('.server-settings-title')).toHaveText(renamed);
  await expect(railTile(page, renamed)).toBeVisible();
  await expect(save).toBeDisabled();

  // Languages are required: removing the last one blocks Save.
  await settings.getByRole('button', { name: 'Remove en' }).click();
  await settings.getByRole('button', { name: 'Remove fr' }).click();
  await expect(save).toBeDisabled();

  // ---- icon + banner → MinIO ----
  const iconField = settings.locator('.bds-field').filter({ hasText: 'Square. Shown in the directory grid' });
  const bannerField = settings.locator('.bds-field').filter({ hasText: 'Wide (3:1). Shown atop the listing.' });

  // Not an image / not a decodable image.
  await iconField.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(iconField.getByText('Please choose an image file.')).toBeVisible();
  await iconField.locator('input[type="file"]').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('nope') });
  await expect(iconField.getByText('That file isn’t a supported image.')).toBeVisible();

  await iconField.locator('input[type="file"]').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png(64, 64, [200, 40, 40]) });
  await expect(iconField.getByRole('button', { name: 'Change' })).toBeVisible();
  const withIcon = await api.get<ServerRow>(`/servers/${created.id}`);
  expect(withIcon.icon_url).toMatch(new RegExp(`^${STACK.minio.endpoint}/${STACK.minio.bucket}/.+`));
  const iconRes = await fetch(withIcon.icon_url!);
  expect(iconRes.status).toBe(200);
  expect(iconRes.headers.get('content-type')).toMatch(/^image\//);
  // The rail tile shows the uploaded icon.
  await expect(railTile(page, renamed).locator('img.server-item-icon')).toHaveAttribute('src', withIcon.icon_url!);

  await bannerField.locator('input[type="file"]').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: png(300, 100, [40, 40, 200]) });
  await expect(bannerField.locator('.server-image-banner-preview img')).toBeVisible();
  const withBanner = await api.get<ServerRow>(`/servers/${created.id}`);
  expect(withBanner.banner_url).toBeTruthy();
  expect((await fetch(withBanner.banner_url!)).status).toBe(200);

  // Remove both: the rows forget them and the objects are deleted.
  await iconField.getByRole('button', { name: 'Remove' }).click();
  await expect(iconField.getByRole('button', { name: 'Upload' })).toBeVisible();
  await bannerField.getByRole('button', { name: 'Remove' }).click();
  await expect(bannerField.getByText('No banner')).toBeVisible();
  const cleared = await api.get<ServerRow>(`/servers/${created.id}`);
  expect(cleared.icon_url ?? null).toBeNull();
  expect(cleared.banner_url ?? null).toBeNull();
  expect((await fetch(withIcon.icon_url!)).status).not.toBe(200);
  expect((await fetch(withBanner.banner_url!)).status).not.toBe(200);
  await expect(railTile(page, renamed).locator('img.server-item-icon')).toHaveCount(0);

  // Close → back to chat.
  await settings.getByRole('button', { name: 'Close settings' }).click();
  await expect(settings).toBeHidden();
  await expectConnected(page, renamed);
});

test('Info, Operators, Log and Actions (reconnect, disconnect)', async ({ launchApp, account, backendApi }) => {
  const api = await backendApi(account);
  const name = `Owned ${uid(8)}`;
  const created = await api.post<ServerRow>('/servers', { hostname: 'localhost', port: IRC_PORT, tls: false, name, languages: ['en'] });
  await api.post(`/servers/${created.id}/verify`);
  const channel = randomChannel('set');

  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('peer') });
  try {
    await peer.join(channel);
    const { page } = await launchApp();
    expect(await loginAs(page, account)).toBe('directory');
    await searchDirectory(page, name);
    await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
    await expectConnected(page, name);
    await joinChannel(page, channel);
    const nick = account.handle!;
    await peer.waitForJoin(channel, nick);

    const settings = await openServerSettings(page, name);

    // Info: what ergo said during registration / CAP negotiation.
    await expect(settingsTab(settings, 'Info')).toHaveAttribute('aria-selected', 'true');
    const row = (label: string) => settings.locator('.server-settings-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
    await expect(row('Version')).toContainText(/ergo/i);
    await expect(row('Network')).not.toHaveText('unknown');
    await expect(row('Hostname')).not.toHaveText('unknown');
    await expect(row('IRCv3 caps').locator('.bds-badge').filter({ hasText: /^server-time$/ })).toBeVisible();

    // Operators (owner only): ergo grants opers through config — the tab
    // generates the block to paste.
    await settingsTab(settings, 'Operators').click();
    await expect(settings.getByRole('heading', { name: 'Operators' })).toBeVisible();
    await expect(settings.getByText(/^Ergo \(built-in\) grants operators through config/)).toBeVisible({ timeout: 20_000 });
    const opAccount = `op${uid(5)}`;
    await settings.getByPlaceholder('account', { exact: true }).fill(opAccount);
    await settings.getByPlaceholder('operclass / class').fill('server-admin');
    await expect(settings.locator('pre.server-settings-cmd-output')).toContainText(opAccount);
    await expect(settings.locator('pre.server-settings-cmd-output')).toContainText('server-admin');
    await expect(settings.getByText('ircd.yaml', { exact: true })).toBeVisible();

    // Log: the raw engine events for this connection; Clear empties it.
    await settingsTab(settings, 'Log').click();
    await expect(settings.locator('.server-settings-log-count')).toHaveText(/^\d+ entries$/);
    await expect(settings.locator('.server-settings-log-row').first()).toBeVisible();
    // The log is live, and the engine's automatic post-connect queries go out
    // through its rate-limited send queue as background traffic, seconds after
    // the JOIN: the self-join MODE (324) and WHO (…315), and the delayed
    // auto-LIST (…323). Wait for their replies so none lands after Clear.
    const logKind = (kind: string) => settings.locator('.server-settings-log-kind').getByText(kind, { exact: true });
    for (const kind of ['324', '315', '323']) await expect(logKind(kind).first()).toBeVisible({ timeout: 30_000 });
    await settings.getByRole('button', { name: 'Clear' }).click();
    await expect(settings.locator('.server-settings-log-count')).toHaveText('No entries yet.');

    // Actions → Reconnect: a fresh IRC session that rejoins the channel.
    await settingsTab(settings, 'Actions').click();
    const quitMark = peer.mark();
    await settings.getByRole('button', { name: 'Reconnect' }).click();
    await peer.waitFor((l) => l.command === 'QUIT' && l.prefix.split('!')[0]!.toLowerCase() === nick.toLowerCase(), 20_000, `${nick} QUIT`, quitMark);
    await peer.waitFor((l) => l.command === 'JOIN' && l.prefix.split('!')[0]!.toLowerCase() === nick.toLowerCase(), 30_000, `${nick} rejoin`, quitMark);

    // Disconnect from server: leaves IRC, drops the server from the saved
    // session, and (the only server) lands back in the directory.
    const leaveMark = peer.mark();
    await settings.getByRole('button', { name: 'Disconnect from server' }).click();
    await peer.waitFor((l) => l.command === 'QUIT' && l.prefix.split('!')[0]!.toLowerCase() === nick.toLowerCase(), 20_000, `${nick} QUIT`, leaveMark);
    await expect(page.getByRole('heading', { name: 'Server Directory' })).toBeVisible();
    await expect(railTile(page, name)).toHaveCount(0);
    await expect.poll(async () => JSON.stringify(await api.get('/me/session')), { timeout: 10_000 }).not.toContain(created.id);
  } finally {
    await peer.quit();
  }
});

test('a non-owner gets no owner tabs', async ({ launchApp }) => {
  const seeded = await seedServer({ name: `Not mine ${uid(8)}` });
  const { page } = await launchApp();
  await continueAsGuest(page, randomNick('guest'));
  await searchDirectory(page, seeded.name);
  await serverCard(page, seeded.name).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page, seeded.name);
  const settings = await openServerSettings(page, seeded.name);
  for (const tab of ['Info', 'Identity', 'Bouncer', 'Actions', 'Log', 'Advanced']) {
    await expect(settingsTab(settings, tab)).toBeVisible();
  }
  await expect(settingsTab(settings, 'Edit')).toHaveCount(0);
  await expect(settingsTab(settings, 'Operators')).toHaveCount(0);
});
