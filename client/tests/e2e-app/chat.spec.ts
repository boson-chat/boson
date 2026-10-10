// Boot → guest login → manually add the test ergo → connect → join a fresh
// channel → messages round-trip with a raw IRC peer → member list shows it.
import {
  test, expect, IRC_HOST, IRC_PORT, uid,
  continueAsGuest, addServerManually, serverCard, joinChannel, sendMessage, memberList, messageList,
} from './fixtures';
import { IrcPeer } from './irc-peer';

test('guest connects to a manually added server and chats with a peer', async ({ launchApp }) => {
  const nick = `app${uid()}`;
  const channel = `#e2e-${uid(8)}`;
  const serverName = `E2E Ergo ${uid(4)}`;

  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
  try {
    await peer.join(channel);

    const { page } = await launchApp();
    await continueAsGuest(page, nick);

    // No backend is running: the public directory can't load, but manual add
    // is local-only and must still work.
    await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: serverName, tls: false });
    const card = serverCard(page, serverName);
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Connect' }).click();

    // Connected → the chat layout replaces the directory; the sidebar shows
    // the server with a "connected" status dot.
    await expect(page.getByRole('complementary', { name: 'Channels' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.sidebar-server-name')).toHaveText(serverName);
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });

    await joinChannel(page, channel);
    await peer.waitForJoin(channel, nick);

    // App → peer.
    const outgoing = `hello from the app ${uid()}`;
    await sendMessage(page, channel, outgoing);
    const got = await peer.waitForPrivmsg(channel, outgoing);
    expect(got.prefix.split('!')[0]).toBe(nick);
    await expect(messageList(page).getByText(outgoing)).toBeVisible();

    // Peer → app.
    const incoming = `hello from the peer ${uid()}`;
    peer.privmsg(channel, incoming);
    await expect(messageList(page).getByText(incoming)).toBeVisible();

    // Member list has both of us.
    const members = memberList(page);
    await expect(members.getByText(peer.nick, { exact: true })).toBeVisible();
    await expect(members.getByText(nick, { exact: true })).toBeVisible();
  } finally {
    await peer.quit();
  }
});
