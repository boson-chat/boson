// The IRC connection drops under the app: it shows the reconnecting splash,
// reconnects by itself and rejoins its channels; cancelling the cycle leaves a
// manual Reconnect button. The drop is simulated with a TCP proxy between the
// app and the e2e ergo (no server-operator powers needed).
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { test, expect, randomChannel, IRC_HOST, IRC_PORT } from './fixtures';
import { connectGuest, connectPeer, messages, memberRow, joinViaUi, say, waitCmd, conversation } from './helpers/chat';
import type { IrcPeer } from './irc-peer';

interface Proxy {
  port: number;
  // While set, new connections are accepted and immediately closed.
  refuse: boolean;
  // Cut every live connection (both directions).
  drop: () => void;
  // The live connections carry nothing more either way but stay open: a
  // phone that left Wi-Fi (its old socket just goes silent). New
  // connections work.
  stallLive: () => void;
  close: () => Promise<void>;
}

async function startProxy(): Promise<Proxy> {
  const live = new Set<Socket>();
  const stalled = new Set<Socket>();
  const proxy: Proxy = {
    port: 0,
    refuse: false,
    stallLive: () => { for (const s of live) stalled.add(s); },
    drop: () => { for (const s of live) s.destroy(); live.clear(); },
    close: () => new Promise<void>((resolve) => { proxy.drop(); server.close(() => resolve()); }),
  };
  const server: Server = createServer((client) => {
    if (proxy.refuse) { client.destroy(); return; }
    const upstream = createConnection({ host: IRC_HOST, port: IRC_PORT });
    live.add(client);
    live.add(upstream);
    const end = (): void => { client.destroy(); upstream.destroy(); live.delete(client); live.delete(upstream); };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
    client.on('data', (b) => { if (!stalled.has(client)) upstream.write(b); });
    upstream.on('data', (b) => { if (!stalled.has(upstream)) client.write(b); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.port = (server.address() as AddressInfo).port;
  return proxy;
}

test.describe('connection drops', () => {
  let peers: IrcPeer[] = [];
  let proxy: Proxy | null = null;
  test.beforeEach(async () => { proxy = await startProxy(); });
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
    await proxy?.close();
  });

  test('auto-reconnects and rejoins; Cancel leaves a manual Reconnect', async ({ launchApp }) => {
    test.setTimeout(240_000);
    const p = proxy!;
    const channel = randomChannel('drop');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp, { port: p.port });
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    peer.privmsg(channel, 'before the drop');
    await expect(messages(page).getByText('before the drop')).toBeVisible();

    // ---- drop; the server comes straight back ----
    let mark = peer.mark();
    p.drop();
    await waitCmd(peer, 'QUIT', nick, () => true, mark);
    // Back by itself: re-registered and re-joined.
    await waitCmd(peer, 'JOIN', nick, (l) => l.params[0] === channel, mark, 60_000);
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
    await conversation(page, channel).click();
    await expect(memberRow(page, peer.nick)).toBeVisible({ timeout: 30_000 });
    // The channel is usable again. (Its earlier messages are gone for a
    // guest — see the fixme below.)
    await say(page, 'back again');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'back again', mark);

    // ---- drop while the server refuses: the conversation stays on screen,
    // under a reconnecting strip ----
    p.refuse = true;
    mark = peer.mark();
    p.drop();
    await waitCmd(peer, 'QUIT', nick, () => true, mark);
    const strip = page.locator('.chat-connection-strip');
    await expect(strip).toContainText(/Reconnecting…|Disconnected/, { timeout: 30_000 });
    await expect(page.locator('.chat-channel-label')).toHaveText(channel.slice(1));
    await expect(messages(page).getByText('back again')).toBeVisible();
    // Cancel the automatic cycle → manual mode.
    const cancel = strip.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeVisible({ timeout: 30_000 });
    await cancel.click();
    await expect(strip).toContainText('Disconnected');
    await expect(cancel).toHaveCount(0);
    const reconnect = strip.getByRole('button', { name: 'Reconnect', exact: true });
    await expect(reconnect).toBeEnabled();

    // Server back; the user reconnects by hand.
    p.refuse = false;
    await reconnect.click();
    await waitCmd(peer, 'JOIN', nick, (l) => l.params[0] === channel, mark, 60_000);
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
    await conversation(page, channel).click();
    peer.privmsg(channel, 'welcome back');
    await expect(messages(page).getByText('welcome back')).toBeVisible();
  });

  // The connection goes silent under a message (the phone switched from
  // Wi-Fi to cellular): the message shows as sending, the app notices the
  // dead connection within seconds, reconnects and sends it after all.
  test('a message sent into a dead connection is delivered after the reconnect', async ({ launchApp }) => {
    test.setTimeout(120_000);
    const p = proxy!;
    const channel = randomChannel('stall');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp, { port: p.port });
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();

    const mark = peer.mark();
    p.stallLive();
    await say(page, 'into the void');
    const sent = messages(page).locator('.message-row', { hasText: 'into the void' });
    await expect(sent).toHaveClass(/message-row-pending/);
    await expect(sent).toContainText('Sending…');
    // Unconfirmed → the connection is probed → no answer, dropped →
    // reconnected → sent again. Seconds, not the ping timeout's minutes.
    // (The server may still hold the old connection's nick, so the new one
    // can come back under a variant of it.)
    await peer.waitFor(
      (l) => l.command === 'PRIVMSG' && l.params[0] === channel && l.params[1] === 'into the void', 60_000, 'the resent message', mark);
    await expect(sent).not.toHaveClass(/message-row-pending/, { timeout: 30_000 });
    // Once, on both sides.
    await expect(messages(page).getByText('into the void')).toHaveCount(1);
  });

  // A network blip keeps a guest's scrollback and open DMs (a guest has no
  // local history store to restore them from).
  test('a guest keeps the conversation and DMs across a reconnect', async ({ launchApp }) => {
    const p = proxy!;
    const channel = randomChannel('keep');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp, { port: p.port });
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    peer.privmsg(channel, 'before the drop');
    peer.privmsg(nick, 'a private word');
    await expect(conversation(page, peer.nick)).toBeVisible();
    const mark = peer.mark();
    p.drop();
    await waitCmd(peer, 'JOIN', nick, (l) => l.params[0] === channel, mark, 60_000);
    await conversation(page, channel).click();
    await expect(messages(page).getByText('before the drop')).toBeVisible();
    await conversation(page, peer.nick).click();
    await expect(messages(page).getByText('a private word')).toBeVisible();
  });
});
