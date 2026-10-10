// Several servers at once: the e2e ergo is reachable both as the directory
// listing (`localhost`) and as a manually added server (`127.0.0.1`), which
// the app treats as two servers. Covers the server-browser modal ("+" in the
// rail) while chatting, the same-server guard (Joined / CURRENTLY
// CONNECTED), switching via the rail, unread + mention badges for the
// background server, the rail context menu (Server details, Leave server)
// and restoring both servers + their channels on relaunch.
import type { Page } from '@playwright/test';
import {
  test, expect, IRC_HOST, IRC_PORT, uid, seedServer, serverCard, joinChannel, composer,
  continueAsGuest, addServerManually, randomChannel, randomNick, messageList,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import {
  cardIn, expectConnected, openServerSettings, railContextMenu, railTile, searchDirectory, sidebarServerName,
} from './helpers/directory';

const isNick = (prefix: string, nick: string): boolean => prefix.split('!')[0]!.toLowerCase() === nick.toLowerCase();

// Guest → directory server A (localhost) + channel → "+" → manual server B
// (127.0.0.1) + channel. Returns the nicks each connection registered with
// (the same guest nick twice on one ergo: the second gets a suffix).
async function connectTwo(page: Page, peer: IrcPeer, a: { name: string; channel: string }, b: { name: string; channel: string }, nick: string) {
  await continueAsGuest(page, nick);
  await searchDirectory(page, a.name);
  await serverCard(page, a.name).getByRole('button', { name: 'Connect' }).click();
  await expectConnected(page, a.name);
  await joinChannel(page, a.channel);
  const joinA = await peer.waitForJoin(a.channel, nick);

  // The directory as a modal over the chat.
  await page.getByRole('button', { name: 'Browse / switch servers' }).click();
  const modal = page.getByRole('dialog', { name: 'Connect to a server' });
  await expect(modal).toBeVisible();
  await searchDirectory(modal, a.name);
  // Same-server guard: the connected server offers no second Connect.
  const cardA = cardIn(modal, a.name);
  await expect(cardA.getByText('CURRENTLY CONNECTED')).toBeVisible();
  await expect(cardA.getByText('Joined', { exact: true })).toBeVisible();
  await expect(cardA.getByRole('button', { name: 'Connect' })).toHaveCount(0);

  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: b.name, tls: false });
  await cardIn(modal, b.name).getByRole('button', { name: 'Connect' }).click();
  await expect(modal).toBeHidden();
  await expectConnected(page, b.name);
  const joinMark = peer.mark();
  await joinChannel(page, b.channel);
  const joinB = await peer.waitFor((l) => l.command === 'JOIN' && (l.params[0] ?? '').toLowerCase() === b.channel.toLowerCase(), 20_000, `join ${b.channel}`, joinMark);
  void joinA;
  return { nickA: nick, nickB: joinB.prefix.split('!')[0]! };
}

test('two servers: browse modal, rail switching, unread + mentions, details, leave', async ({ launchApp }) => {
  const seeded = await seedServer({ name: `Multi A ${uid(8)}` });
  const a = { name: seeded.name, channel: randomChannel('ma') };
  const b = { name: `Multi B ${uid(4)}`, channel: randomChannel('mb') };
  const nick = randomNick('mu');
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('peer') });
  try {
    await peer.join(a.channel);
    await peer.join(b.channel);
    const { page } = await launchApp();
    const { nickA } = await connectTwo(page, peer, a, b, nick);

    // Rail: both servers, B (just connected) active.
    await expect(railTile(page, b.name)).toHaveAttribute('aria-current', 'true');
    await expect(railTile(page, a.name)).not.toHaveAttribute('aria-current', 'true');

    // Activity on the background server A: an unread dot, then a mention count.
    peer.privmsg(a.channel, `background chatter ${uid()}`);
    await expect(page.getByLabel(`1 unread message in ${a.name}`)).toBeVisible();
    peer.privmsg(a.channel, `${nickA}: are you there? ${uid()}`);
    await expect(page.getByLabel(`1 mention in ${a.name}`)).toBeVisible();
    await expect(railTile(page, a.name)).toHaveClass(/server-item-mention/);
    // Messages on the foreground server's active channel don't badge anything.
    const here = `foreground ${uid()}`;
    peer.privmsg(b.channel, here);
    await expect(messageList(page).getByText(here)).toBeVisible();
    await expect(page.getByLabel(new RegExp(`in ${b.name}$`))).toHaveCount(0);

    // Switch to A via the rail: its chat, and its badge goes away.
    await railTile(page, a.name).click();
    await expect(sidebarServerName(page)).toHaveText(a.name);
    await expect(railTile(page, a.name)).toHaveAttribute('aria-current', 'true');
    await page.getByRole('complementary', { name: 'Channels' }).getByText(a.channel.replace(/^#/, ''), { exact: true }).click();
    await expect(composer(page, a.channel)).toBeVisible();
    await expect(messageList(page).getByText('are you there?', { exact: false })).toBeVisible();
    await expect(page.getByLabel(`1 unread message in ${a.name}`)).toHaveCount(0);

    // Context menu → Server details for B; selecting another tile from the
    // settings page goes back to chat on that server.
    const settings = await openServerSettings(page, b.name);
    await expect(settings.locator('.server-settings-title')).toHaveText(b.name);
    await railTile(page, a.name).click();
    await expect(settings).toBeHidden();
    await expect(sidebarServerName(page)).toHaveText(a.name);

    // Escape closes the context menu without doing anything.
    const menu = await railContextMenu(page, b.name);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Leave server A from its tile: it quits IRC, the rail drops it and B
    // becomes active.
    const quitMark = peer.mark();
    await (await railContextMenu(page, a.name)).getByRole('menuitem', { name: 'Leave server' }).click();
    await peer.waitFor((l) => l.command === 'QUIT' && isNick(l.prefix, nickA), 20_000, `${nickA} QUIT`, quitMark);
    await expect(railTile(page, a.name)).toHaveCount(0);
    await expect(sidebarServerName(page)).toHaveText(b.name);
    await expect(railTile(page, b.name)).toHaveAttribute('aria-current', 'true');
  } finally {
    await peer.quit();
  }
});

test('relaunch restores both servers, their channels and the active one', async ({ launchApp }) => {
  const seeded = await seedServer({ name: `Restore A ${uid(8)}` });
  const a = { name: seeded.name, channel: randomChannel('ra') };
  const b = { name: `Restore B ${uid(4)}`, channel: randomChannel('rb') };
  const nick = randomNick('rs');
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('peer') });
  try {
    await peer.join(a.channel);
    await peer.join(b.channel);
    const first = await launchApp();
    const { nickA, nickB } = await connectTwo(first.page, peer, a, b, nick);
    // Make A the active server before quitting.
    await railTile(first.page, a.name).click();
    await expect(sidebarServerName(first.page)).toHaveText(a.name);

    const quitMark = peer.mark();
    await first.app.close();
    await peer.waitFor((l) => l.command === 'QUIT' && isNick(l.prefix, nickB), 15_000, `${nickB} QUIT`, quitMark);

    const rejoinMark = peer.mark();
    const { page } = await launchApp();
    // Straight back into chat on the previously active server, both tiles up.
    await expectConnected(page, a.name);
    await expect(railTile(page, b.name)).toBeVisible();
    await expect(railTile(page, a.name)).toHaveAttribute('aria-current', 'true');
    // Both connections re-joined their channel on the IRC side.
    const joined = new Set<string>();
    await peer.waitFor((l) => {
      if (l.command === 'JOIN') joined.add((l.params[0] ?? '').toLowerCase());
      return joined.has(a.channel.toLowerCase()) && joined.has(b.channel.toLowerCase());
    }, 30_000, 'both channels re-joined', rejoinMark);
    await expect(page.getByRole('complementary', { name: 'Channels' }).getByText(a.channel.replace(/^#/, ''), { exact: true })).toBeVisible();
    await railTile(page, b.name).click();
    await expectConnected(page, b.name);
    await expect(page.getByRole('complementary', { name: 'Channels' }).getByText(b.channel.replace(/^#/, ''), { exact: true })).toBeVisible();
    void nickA;
  } finally {
    await peer.quit();
  }
});
