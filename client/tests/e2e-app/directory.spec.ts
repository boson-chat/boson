// Server directory (guest): the public list from the real backend — search
// (server-side, debounced), language chips, NSFW toggle, sort by user count,
// health + user-count badges, Refresh with its refetch bar, empty / no-match
// states, the backend-down error state, and the Advanced → manual add /
// remove of local servers (incl. a server password, checked against ZNC).
import {
  test, expect, IRC_HOST, IRC_PORT, uid, seedServer, field,
  continueAsGuest, addServerManually, serverCard, randomNick,
} from './fixtures';
import {
  controlApi, directoryCards, expectConnected, searchDirectory, setServerStats, sidebarServerName,
} from './helpers/directory';

// One unique search token per test: every seeded server carries it in its
// name, so a server-side search narrows the shared directory to this test's
// rows only.
const token = (): string => `dirk${uid(8)}`;

test('search, language chips, NSFW, user counts, health and Refresh', async ({ launchApp }) => {
  const t = token();
  const big = await seedServer({ name: `Big ${t}`, languages: ['en'], tags: ['gaming', 'e2e'], description: `The busy one ${t}` });
  const spanish = await seedServer({ name: `Hola ${t}`, languages: ['es'] });
  const japanese = await seedServer({ name: `Konnichiwa ${t}`, languages: ['ja'] });
  const nsfw = await seedServer({ name: `Late night ${t}`, languages: ['en'], isNsfw: true });
  setServerStats(big.id, { userCount: 1234, health: 'up' });
  setServerStats(spanish.id, { userCount: 1, health: 'down' });

  const { app, page } = await launchApp();
  const api = await controlApi(app);
  await continueAsGuest(page, randomNick('dir'));

  await searchDirectory(page, t);
  const cards = directoryCards(page);
  // NSFW rows are hidden by default; the rest are sorted by user count
  // (the default backend sort), unknown counts last.
  await expect(cards).toHaveCount(3);
  await expect(cards.locator('.directory-card-name')).toContainText([big.name, spanish.name, japanese.name]);
  // The search really went to the backend as `q`.
  expect(await api.requests()).toContain(`GET /servers?q=${t}`);

  const bigCard = serverCard(page, big.name);
  await expect(bigCard.locator('.directory-card-count')).toHaveText(/1,234 users/);
  await expect(bigCard.locator('.directory-card-status')).toHaveText('ONLINE');
  await expect(bigCard.locator('.directory-card-desc')).toHaveText(`The busy one ${t}`);
  await expect(bigCard.locator('.directory-card-tag')).toHaveText(['VERIFIED', 'GAMING', 'E2E']);
  await expect(bigCard.locator('.directory-card-host')).toHaveText(`localhost:${IRC_PORT}`);
  const spanishCard = serverCard(page, spanish.name);
  await expect(spanishCard.locator('.directory-card-count')).toHaveText(/^\D*1 user$/);
  await expect(spanishCard.locator('.directory-card-status')).toHaveText('OFFLINE');
  await expect(serverCard(page, japanese.name).locator('.directory-card-count')).toHaveCount(0);

  // Language chips filter the fetched rows.
  const chips = page.getByRole('tablist', { name: 'Filter by language' });
  await chips.getByRole('tab', { name: 'Español' }).click();
  await expect(chips.getByRole('tab', { name: 'Español' })).toHaveAttribute('aria-selected', 'true');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(spanish.name);
  await chips.getByRole('tab', { name: '日本語' }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(japanese.name);
  await chips.getByRole('tab', { name: 'English' }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(big.name);

  // NSFW toggle reveals the NSFW listing.
  await page.getByText('Show NSFW', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Show NSFW' })).toBeChecked();
  await expect(serverCard(page, nsfw.name)).toBeVisible();
  await expect(cards).toHaveCount(2);
  await page.getByText('Show NSFW', { exact: true }).click();
  await expect(serverCard(page, nsfw.name)).toHaveCount(0);

  // A filter combination nothing matches.
  await searchDirectory(page, `${spanish.name}`);
  await expect(page.locator('.directory-empty')).toHaveText('No servers match these filters.');
  await chips.getByRole('tab', { name: 'All' }).click();
  await expect(cards).toHaveCount(1);

  // A search the backend finds nothing for.
  await searchDirectory(page, `${t}zzz`);
  await expect(page.locator('.directory-empty')).toHaveText('No servers found.');

  // Refresh refetches the current query: a server registered meanwhile shows
  // up, with the refetch bar above the (kept) results while it loads.
  await searchDirectory(page, t);
  await expect(cards).toHaveCount(3);
  const late = await seedServer({ name: `Latecomer ${t}`, languages: ['en'] });
  await api.setDelay(1_500);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Updating results' })).toBeVisible();
  await expect(cards).toHaveCount(3);
  await expect(serverCard(page, late.name)).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Updating results' })).toBeHidden();
  await expect(cards).toHaveCount(4);
});

test('backend down: error banner, local servers still usable, Refresh recovers', async ({ launchApp }) => {
  const t = token();
  const listed = await seedServer({ name: `Listed ${t}` });
  const localName = `Local ${uid(4)}`;

  const { app, page } = await launchApp();
  const api = await controlApi(app);
  await api.setDown(true);
  await continueAsGuest(page, randomNick('down'));

  // The public list failed: banner + empty list, not an endless spinner.
  const banner = page.getByRole('alert').filter({ hasText: "Couldn't load directory" });
  await expect(banner).toBeVisible();
  await expect(page.locator('.directory-empty')).toHaveText('No servers found.');

  // Manually added servers don't need the backend.
  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: localName, tls: false });
  await expect(serverCard(page, localName)).toBeVisible();

  // Backend back: Refresh loads the list and clears the error.
  await api.setDown(false);
  await searchDirectory(page, t);
  await expect(serverCard(page, listed.name)).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(banner).toBeHidden();

  // The local server still connects.
  await serverCard(page, localName).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page, localName);
});

test('Advanced: manual add validates, keeps TLS options, removes; server password reaches ZNC', async ({ launchApp, zncUser }) => {
  const { page } = await launchApp();
  await continueAsGuest(page, randomNick('adv'));

  // Advanced toggles the manual-add affordances.
  await expect(page.getByRole('button', { name: '+ Add server manually' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: '+ Add server manually' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a server manually' });

  // Validation: bad port, half-filled SASL.
  await field(dialog, 'Hostname').fill('irc.example.invalid');
  await field(dialog, 'Port').fill('99999');
  await dialog.getByRole('button', { name: 'Add server' }).click();
  await expect(dialog.getByText('Port must be a number between 1 and 65535.')).toBeVisible();
  await field(dialog, 'Port').fill('6697');
  await field(dialog, 'SASL account').fill('someone');
  await dialog.getByRole('button', { name: 'Add server' }).click();
  await expect(dialog.getByText('SASL needs both an account and a password (or leave both blank).')).toBeVisible();
  await field(dialog, 'SASL account').fill('');

  // TLS (default on) + skip-verification; no display name → the hostname.
  await expect(dialog.getByRole('checkbox', { name: 'Use TLS (recommended)' })).toBeChecked();
  await dialog.getByText('Skip certificate verification (self-signed certs)').click();
  await expect(dialog.getByRole('checkbox', { name: 'Skip certificate verification (self-signed certs)' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Add server' }).click();
  await expect(dialog).toBeHidden();
  const tlsCard = serverCard(page, 'irc.example.invalid');
  await expect(tlsCard.locator('.directory-card-host')).toHaveText('irc.example.invalid:6697 (TLS)');
  await expect(tlsCard.locator('.directory-card-tag-local')).toHaveText('LOCAL');

  // Cancel leaves nothing behind.
  await page.getByRole('button', { name: '+ Add server manually' }).click();
  await field(dialog, 'Hostname').fill('never.added.invalid');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(serverCard(page, 'never.added.invalid')).toHaveCount(0);

  // Remove (Advanced only) deletes the local entry.
  await tlsCard.getByRole('button', { name: 'Remove' }).click();
  await expect(tlsCard).toHaveCount(0);

  // A server password is sent as PASS: ZNC only lets us in with it.
  const zncName = `ZNC ${uid(4)}`;
  await page.getByRole('button', { name: '+ Add server manually' }).click();
  await field(dialog, 'Hostname').fill(zncUser.host);
  await field(dialog, 'Port').fill(String(zncUser.port));
  await field(dialog, 'Display name').fill(zncName);
  await dialog.getByText('Use TLS (recommended)').click();
  await expect(dialog.getByText('Skip certificate verification (self-signed certs)')).toHaveCount(0);
  await field(dialog, 'Server password').fill(`${zncUser.username}/${zncUser.network}:${zncUser.password}`);
  await dialog.getByRole('button', { name: 'Add server' }).click();
  await expect(dialog).toBeHidden();
  const zncCard = serverCard(page, zncName);
  await expect(zncCard.locator('.directory-card-host')).toHaveText(`${zncUser.host}:${zncUser.port}`);
  await zncCard.getByRole('button', { name: 'Connect' }).click();
  // Registered with ZNC (which never lets a client in without the right
  // PASS); the leased user's upstream network is parked, hence "offline".
  await expect(sidebarServerName(page)).toHaveText(zncName, { timeout: 30_000 });
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', /^(connected|upstream-offline)$/, { timeout: 30_000 });
});
