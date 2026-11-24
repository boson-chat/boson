// Getting your nick back: when the server registers the app under a
// fallback (nick_) because something else still holds the nick (typically
// your own previous session for a minute after a reload), the app says so
// and takes the nick back as soon as it's free. And going offline shows.
import {
  test, expect, IRC_HOST, IRC_PORT, uid,
  continueAsGuest, addServerManually, serverCard, joinChannel, memberList, messageList,
} from './fixtures';
import { IrcPeer } from './irc-peer';

test('connected under a fallback nick, the app says so and reclaims the nick once it is free', async ({ launchApp }) => {
  const nick = `rc${uid()}`;
  const channel = `#e2e-${uid(8)}`;
  const serverName = `E2E Reclaim ${uid(4)}`;

  // The "previous session": holds the nick, in the same channel.
  const holder = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick });
  try {
    await holder.join(channel);
    const { page } = await launchApp();
    await continueAsGuest(page, nick);
    await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: serverName, tls: false });
    await serverCard(page, serverName).getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await joinChannel(page, channel);

    const members = memberList(page);
    await expect(members.getByText(`${nick}_`, { exact: true })).toBeVisible({ timeout: 20_000 });
    // Says so (after the first retry, ~5s in).
    await expect(page.getByText(/is still in use, most likely by your previous session/)).toBeVisible({ timeout: 15_000 });

    // The holder goes away: the nick comes back without the user doing anything.
    await holder.quit();
    await expect(members.getByText(nick, { exact: true })).toBeVisible({ timeout: 20_000 });
    // The notes sit in the channel's collapsed activity line: open it.
    await messageList(page).getByRole('button', { name: /still in use/ }).click();
    await expect(messageList(page).getByText(`You're “${nick}” again.`)).toBeVisible();
  } finally {
    await holder.quit().catch(() => {});
  }
});

test('going offline shows a banner and greys your presence; coming back clears it', async ({ launchApp }) => {
  const nick = `off${uid()}`;
  const serverName = `E2E Offline ${uid(4)}`;
  const { page } = await launchApp();
  await continueAsGuest(page, nick);
  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: serverName, tls: false });
  await serverCard(page, serverName).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  const banner = page.getByRole('status').filter({ hasText: "You're offline" });
  await expect(banner).toBeHidden();

  await page.context().setOffline(true);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Messages will send when you\'re back.');
  await expect(page.getByRole('button', { name: /^You: .*\(Offline/ })).toBeVisible();

  await page.context().setOffline(false);
  await expect(banner).toBeHidden();
});
