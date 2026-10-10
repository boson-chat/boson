// Bouncer (ZNC) flow against the real app: global bouncer profile → bouncer
// network → connect. ZNC's network starts DISCONNECTED upstream; the app must
// auto-connect it on attach (strip shows "connecting…" then clears), messages
// must round-trip through ZNC to a peer on ergo, and the user must be able to
// disconnect / reconnect the upstream from the UI.
import {
  test, expect, IRC_HOST, IRC_PORT, uid,
  continueAsGuest, configureBouncerProfile, joinChannel, sendMessage, messageList,
} from './fixtures';
import { IrcPeer } from './irc-peer';

test('bouncer network auto-connects upstream, relays messages, and can be disconnected + reconnected', async ({ launchApp, zncUser }) => {
  const channel = `#e2e-bnc-${uid(8)}`;
  const displayName = `ZNC Ergo ${uid(4)}`;
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
  try {
    await peer.join(channel);

    const { page } = await launchApp();
    await continueAsGuest(page, `bnc${uid()}`);
    await configureBouncerProfile(page, {
      host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
    });

    // Directory → Bouncer tab → add the ZNC network → Connect.
    await page.getByRole('tab', { name: 'Bouncer' }).click();
    await expect(page.getByText(`${zncUser.host}:${zncUser.port}`)).toBeVisible();
    await page.getByPlaceholder('Display name').fill(displayName);
    await page.getByPlaceholder('ZNC network, e.g. libera').fill(zncUser.network);
    await page.getByRole('button', { name: 'Add network' }).click();
    const row = page.locator('.directory-bouncer-row').filter({ hasText: displayName });
    await expect(row).toBeVisible();
    // Record every state the upstream strip passes through from here on — the
    // "connecting" phase can be shorter than any polling interval.
    await page.evaluate(() => {
      const w = window as unknown as { __stripStates: string[] };
      w.__stripStates = [];
      const seen = (): void => {
        const el = document.querySelector('.chat-bouncer-upstream-banner');
        const st = el?.getAttribute('data-state') ?? 'none';
        if (w.__stripStates[w.__stripStates.length - 1] !== st) w.__stripStates.push(st);
      };
      new MutationObserver(seen).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await row.getByRole('button', { name: 'Connect', exact: true }).click();

    // Chat layout for the bouncer server. ZNC answers instantly but is not on
    // the network; auto-connect must take it there without any user action.
    const sidebar = page.getByRole('complementary', { name: 'Channels' });
    await expect(page.locator('.sidebar-server-name')).toHaveText(displayName, { timeout: 30_000 });
    const strip = page.locator('.chat-bouncer-upstream-banner');
    const dot = page.locator('.sidebar-status-dot');
    await expect(dot).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(strip).toBeHidden();
    await expect(sidebar.getByLabel('via bouncer', { exact: true })).toBeVisible();
    const states = await page.evaluate(() => (window as unknown as { __stripStates: string[] }).__stripStates);
    // Typical sequence: absent → "isn't connected" (attach burst) →
    // "connecting…" (auto-connect sent `connect`) → absent (upstream 001).
    // The intermediate states can come and go within a single frame on a
    // fast runner, so only the end state is asserted here; that auto-connect
    // really reached the network is proven below (JOIN + messages relayed
    // through ZNC to ergo, which only works once ZNC is upstream).
    expect(states[states.length - 1]).toBe('none');

    // Join through ZNC; the peer on ergo sees the bouncer's upstream nick.
    const joinMark = peer.mark();
    await joinChannel(page, channel);
    const join = await peer.waitFor(
      (l) => l.command === 'JOIN' && (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
      30_000, `bouncer joining ${channel}`, joinMark,
    );
    const upstreamNick = join.prefix.split('!')[0]!;

    const out1 = `via znc ${uid()}`;
    await sendMessage(page, channel, out1);
    const got = await peer.waitForPrivmsg(channel, out1);
    expect(got.prefix.split('!')[0]).toBe(upstreamNick);
    const in1 = `to znc ${uid()}`;
    peer.privmsg(channel, in1);
    await expect(messageList(page).getByText(in1)).toBeVisible();

    // ---- Disconnect the network from the server rail context menu ----
    const quitMark = peer.mark();
    await page.getByRole('navigation', { name: 'Servers' }).locator('[aria-current="true"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Disconnect network' }).click();
    await expect(strip).toHaveAttribute('data-state', 'disconnected', { timeout: 30_000 });
    await expect(strip).toContainText("Your bouncer isn't connected to");
    await expect(dot).toHaveAttribute('data-state', 'upstream-offline');
    await peer.waitFor(
      (l) => l.command === 'QUIT' && l.prefix.split('!')[0] === upstreamNick,
      30_000, `${upstreamNick} QUIT upstream`, quitMark,
    );

    // ---- Reconnect from the strip ----
    const rejoinMark = peer.mark();
    await strip.getByRole('button', { name: 'Connect' }).click();
    await expect(strip).toBeHidden({ timeout: 45_000 });
    await expect(dot).toHaveAttribute('data-state', 'connected');
    // ZNC rejoins the channel it remembers for us.
    await peer.waitFor(
      (l) => l.command === 'JOIN' && (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
      30_000, `bouncer re-joining ${channel}`, rejoinMark,
    );
    const out2 = `back via znc ${uid()}`;
    await sendMessage(page, channel, out2);
    await peer.waitForPrivmsg(channel, out2);
  } finally {
    await peer.quit();
  }
});
