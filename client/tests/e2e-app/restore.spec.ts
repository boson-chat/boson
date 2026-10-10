// Persistence: a server + channel joined in one launch are restored, and
// reconnected automatically, when the app is relaunched on the same profile.
import {
  test, expect, IRC_HOST, IRC_PORT, uid,
  continueAsGuest, addServerManually, serverCard, joinChannel, composer, sendMessage, messageList,
} from './fixtures';
import { IrcPeer } from './irc-peer';

test('relaunch restores the server and channel and reconnects', async ({ launchApp }) => {
  const nick = `rst${uid()}`;
  const channel = `#e2e-rst-${uid(8)}`;
  const serverName = `Restore Ergo ${uid(4)}`;

  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
  try {
    await peer.join(channel);

    // ---- first launch: set everything up ----
    const first = await launchApp();
    await continueAsGuest(first.page, nick);
    await addServerManually(first.page, { hostname: IRC_HOST, port: IRC_PORT, name: serverName, tls: false });
    await serverCard(first.page, serverName).getByRole('button', { name: 'Connect' }).click();
    await expect(first.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await joinChannel(first.page, channel);
    await peer.waitForJoin(channel, nick);

    // Quit the app the normal way (engine sidecar is stopped with it) and
    // make sure the peer saw the app's connection go away.
    const quitMark = peer.mark();
    await first.app.close();
    await peer.waitFor(
      (l) => l.command === 'QUIT' && l.prefix.split('!')[0]!.toLowerCase() === nick.toLowerCase(),
      15_000, `${nick} QUIT`, quitMark,
    );

    // ---- second launch, same profile: no clicks before the assertions ----
    const rejoinMark = peer.mark();
    const second = await launchApp();
    const { page } = second;

    // Straight back into the chat layout (no login, no directory).
    await expect(page.locator('.sidebar-server-name')).toHaveText(serverName, { timeout: 30_000 });
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    await expect(
      page.getByRole('complementary', { name: 'Channels' }).getByText(channel.replace(/^#/, ''), { exact: true }),
    ).toBeVisible();

    // The app really re-registered and re-joined on the IRC side.
    await peer.waitFor(
      (l) => l.command === 'JOIN' && l.prefix.split('!')[0]!.toLowerCase() === nick.toLowerCase() &&
        (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
      30_000, `${nick} re-joining ${channel}`, rejoinMark,
    );

    // And the restored channel is usable.
    await page.getByRole('complementary', { name: 'Channels' }).getByText(channel.replace(/^#/, ''), { exact: true }).click();
    await expect(composer(page, channel)).toBeVisible();
    const text = `after restore ${uid()}`;
    await sendMessage(page, channel, text);
    await peer.waitForPrivmsg(channel, text);
    await expect(messageList(page).getByText(text)).toBeVisible();
  } finally {
    await peer.quit();
  }
});
