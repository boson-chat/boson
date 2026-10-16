// boson://join deep links (the website's /discover cards), delivered the way
// the OS does: warm (open-url on macOS / a second instance's argv elsewhere)
// and cold (the URL in the launching argv, before any window exists).
// Unknown host → a local server is added and connected; a host:port the
// directory already lists → that listing is used; malformed links are
// ignored.
import {
  test, expect, IRC_HOST, IRC_PORT, uid, seedServer, serverCard, deliverDeepLink,
  continueAsGuest, randomNick,
} from './fixtures';
import { cardIn, directoryCards, expectConnected, railTile, searchDirectory, sidebarServerName } from './helpers/directory';
import { secondInstance } from './desktop-app';

const joinUrl = (p: Record<string, string>): string => `boson://join?${new URLSearchParams(p)}`;

test('warm deep links: malformed ones are ignored, a new host is added locally and connected', async ({ launchApp }) => {
  const name = `Linked ${uid(6)}`;
  const nick = randomNick('dl');
  const { app, page } = await launchApp();
  await continueAsGuest(page, nick);
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const localCards = directoryCards(page).filter({ has: page.locator('.directory-card-tag-local') });
  await expect(localCards).toHaveCount(0);

  // Malformed / foreign links: no host, port out of range, another verb,
  // another scheme. None of them may add or connect anything…
  for (const bad of [
    'boson://join?port=6667',
    `boson://join?host=${IRC_HOST}&port=70000`,
    `boson://join?host=${IRC_HOST}&port=abc`,
    `boson://launch?host=${IRC_HOST}&port=${IRC_PORT}`,
    `https://boson.chat/join?host=${IRC_HOST}&port=${IRC_PORT}`,
  ]) {
    await deliverDeepLink(app, bad);
  }
  // …which the valid link right behind them proves: it is the only effect.
  await deliverDeepLink(app, joinUrl({ host: IRC_HOST, port: String(IRC_PORT), tls: '0', name }));
  await expectConnected(page, name);
  await expect(page.getByRole('navigation', { name: 'Servers' }).getByRole('button')).toHaveCount(2); // tile + "+"

  // The link minted a local server entry (removable in Advanced).
  await page.getByRole('button', { name: 'Browse / switch servers' }).click();
  const modal = page.getByRole('dialog', { name: 'Connect to a server' });
  await modal.getByRole('button', { name: 'Advanced', exact: true }).click();
  const card = cardIn(modal, name);
  await expect(card.locator('.directory-card-tag-local')).toHaveText('LOCAL');
  await expect(card.locator('.directory-card-host')).toHaveText(`${IRC_HOST}:${IRC_PORT}`);
  await expect(card.getByText('CURRENTLY CONNECTED')).toBeVisible();
  await expect(directoryCards(modal).filter({ has: page.locator('.directory-card-tag-local') })).toHaveCount(1);
  await modal.getByRole('button', { name: 'Close' }).click();

  // The same link again (a second click on the website) just focuses the
  // existing connection — no duplicate entry or connection.
  await deliverDeepLink(app, joinUrl({ host: IRC_HOST, port: String(IRC_PORT), tls: '0', name: 'Other label' }));
  await expect(sidebarServerName(page)).toHaveText(name);
  await expect(page.getByRole('navigation', { name: 'Servers' }).getByRole('button')).toHaveCount(2);
});

test('a deep link to a listed host:port connects the directory listing (second-instance delivery)', async ({ launchApp }) => {
  // A unique, unresolvable host: only this test's listing matches it.
  const host = `dl-${uid(8)}.invalid`;
  const listed = await seedServer({ name: `Listed ${uid(8)}`, hostname: host, port: 6697, tls: true });
  const { app, page } = await launchApp();
  await continueAsGuest(page, randomNick('dl'));
  await searchDirectory(page, listed.name);
  await expect(serverCard(page, listed.name)).toBeVisible();

  // Windows/Linux delivery: a second app instance's argv (case differs —
  // hosts match case-insensitively).
  await secondInstance(app, ['--some-flag', joinUrl({ host: host.toUpperCase(), port: '6697', name: 'Ignored label' })]);

  // The listing's own name, not the link's label; no local entry minted.
  await expect(sidebarServerName(page)).toHaveText(listed.name, { timeout: 30_000 });
  await expect(railTile(page, listed.name)).toBeVisible();
  await page.getByRole('button', { name: 'Browse / switch servers' }).click();
  const modal = page.getByRole('dialog', { name: 'Connect to a server' });
  await expect(modal.locator('.directory-card-tag-local')).toHaveCount(0);
});

test('cold start: a deep link in the launch argv is joined once the user is in', async ({ launchApp }) => {
  const name = `Cold ${uid(6)}`;
  const { page } = await launchApp({
    args: [joinUrl({ host: IRC_HOST, port: String(IRC_PORT), tls: 'false', name })],
  });
  // The link waits behind the login screen…
  await expect(page.getByRole('button', { name: 'Continue without an account' })).toBeVisible({ timeout: 30_000 });
  // …and is joined as soon as there's an identity to connect with.
  await page.getByRole('button', { name: 'Continue without an account' }).click();
  await page.getByPlaceholder('your-nick').fill(randomNick('cold'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expectConnected(page, name);
});
