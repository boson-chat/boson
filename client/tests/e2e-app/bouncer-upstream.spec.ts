// Bouncer upstream (ZNC ⇄ network) state end to end: Server settings →
// Bouncer (route a server through ZNC, network name, the auto-connect
// toggle, the live status card with Connect / Disconnect network), the
// server-rail context menu, the channel-sidebar state, ZNC's buffer replay
// when the app re-attaches, and upstream changes made behind the app's back
// (another ZNC client) that the app must notice.
//
// ZNC playback: infra/e2e/znc.conf loads only `controlpanel` — no
// `playback` module (znc.in/playback) — so what's covered here is ZNC's
// classic buffer replay on attach, not the playback CAP.
import {
  test, expect, uid, IRC_HOST, IRC_PORT, field, type ZncUser,
  continueAsGuest, configureBouncerProfile, addServerManually, serverCard, joinChannel, sendMessage, messageList, composer,
} from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { IrcPeer } from './irc-peer';
import { zncOnIrc, zncUpstream } from './helpers/znc-admin';

const strip = (page: Page): Locator => page.locator('.chat-bouncer-upstream-banner');
const dot = (page: Page): Locator => page.locator('.sidebar-status-dot');
const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Channels' });
const railTile = (page: Page, name: string): Locator =>
  page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: new RegExp(`^${name}`) });

// Records every state the upstream strip passes through (the "connecting"
// phase can be shorter than any polling interval). Read with stripStates().
async function recordStripStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __stripStates: string[]; __stripObs?: MutationObserver };
    w.__stripStates = [];
    w.__stripObs?.disconnect();
    const seen = (): void => {
      const st = document.querySelector('.chat-bouncer-upstream-banner')?.getAttribute('data-state') ?? 'none';
      if (w.__stripStates[w.__stripStates.length - 1] !== st) w.__stripStates.push(st);
    };
    seen();
    w.__stripObs = new MutationObserver(seen);
    w.__stripObs.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
}
const stripStates = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __stripStates: string[] }).__stripStates);

// Directory → Bouncer tab → add the user's ZNC network → Connect, and wait
// until auto-connect has the bouncer on the network.
async function attachBouncerNetwork(page: Page, z: ZncUser, name: string): Promise<void> {
  await page.getByRole('tab', { name: 'Bouncer' }).click();
  await page.getByPlaceholder('Display name').fill(name);
  await page.getByPlaceholder('ZNC network, e.g. libera').fill(z.network);
  await page.getByRole('button', { name: 'Add network' }).click();
  await page.locator('.directory-bouncer-row').filter({ hasText: name })
    .getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.sidebar-server-name')).toHaveText(name, { timeout: 30_000 });
  await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
  await expect(strip(page)).toBeHidden();
}

async function openServerSettings(page: Page, section: RegExp): Promise<Locator> {
  await sidebar(page).getByRole('button', { name: 'Server details' }).click();
  const settings = page.locator('main.server-settings');
  await expect(settings).toBeVisible();
  await settings.getByRole('tab', { name: section }).click();
  return settings;
}

async function setToggle(scope: Locator, label: string, want: boolean): Promise<void> {
  const box = scope.getByRole('checkbox', { name: label, exact: true });
  if ((await box.isChecked()) !== want) await scope.getByText(label, { exact: true }).click();
  await expect(box).toBeChecked({ checked: want });
}

const ROUTE = 'Route this server through the bouncer';
const AUTO = 'Automatically connect the network when the bouncer is disconnected';

test.describe('bouncer upstream', () => {
  test('Server settings → Bouncer: route a server through ZNC, auto-connect off then on, status card + rail menu', async ({ launchApp, zncUser }) => {
    const serverName = `Routed Ergo ${uid(4)}`;
    const { page } = await launchApp();
    await continueAsGuest(page, `rt${uid()}`);

    // A plain, directly connected server first.
    await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: serverName, tls: false });
    await serverCard(page, serverName).getByRole('button', { name: 'Connect' }).click();
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
    // (No bouncer-upstream state on a direct link. Ergo itself advertises
    // znc.in/playback, so the sidebar's display-only "via bouncer" badge can
    // show even here — not asserted.)
    await expect(sidebar(page).getByLabel(/network offline|network connecting/)).toHaveCount(0);

    // Bouncer section before a bouncer exists: says so, and has no status
    // card (the link isn't via a bouncer).
    let settings = await openServerSettings(page, /^Bouncer/);
    await expect(settings.getByText('No bouncer is enabled yet.')).toBeVisible();
    await expect(settings.locator('.server-settings-bouncer-upstream')).toHaveCount(0);
    await settings.getByRole('button', { name: 'Close settings' }).click();

    await configureBouncerProfile(page, {
      host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
    });

    // Route it through ZNC, auto-connect OFF.
    settings = await openServerSettings(page, /^Bouncer/);
    await expect(settings.getByText('No bouncer is enabled yet.')).toHaveCount(0);
    await expect(settings.getByRole('checkbox', { name: AUTO })).toBeChecked(); // default on
    await setToggle(settings, ROUTE, true);
    await field(settings, 'ZNC network name').fill(zncUser.network);
    await setToggle(settings, AUTO, false);
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Saved — reconnect to apply')).toBeVisible();

    await recordStripStates(page);
    await settings.getByRole('tab', { name: /^Actions/ }).click();
    await settings.getByRole('button', { name: 'Reconnect' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();

    // Attached to ZNC, which is off the network — and stays off: no
    // auto-connect. The strip, the sidebar and the rail all say so.
    await expect(strip(page)).toHaveAttribute('data-state', 'disconnected', { timeout: 30_000 });
    await expect(strip(page)).toContainText("Your bouncer isn't connected to");
    await expect(dot(page)).toHaveAttribute('data-state', 'upstream-offline');
    await expect(dot(page)).toHaveAccessibleName('Bouncer connected · network offline');
    await expect(sidebar(page).getByLabel('via bouncer, network offline')).toBeVisible();
    await expect(railTile(page, serverName)).toHaveAccessibleName(`${serverName} (network offline)`);
    // Auto-connect would fire ~2s after the attach burst; give it well over
    // that and make sure neither the app nor ZNC moved.
    await page.waitForTimeout(6_000);
    expect(await stripStates(page)).not.toContain('connecting');
    await expect(strip(page)).toHaveAttribute('data-state', 'disconnected');
    expect(await zncOnIrc(zncUser)).toBe(false);

    // Settings were persisted for this server.
    settings = await openServerSettings(page, /^Bouncer/);
    await expect(settings.getByRole('checkbox', { name: ROUTE })).toBeChecked();
    await expect(field(settings, 'ZNC network name')).toHaveValue(zncUser.network);
    await expect(settings.getByRole('checkbox', { name: AUTO })).not.toBeChecked();

    // Status card: offline → Connect network → connected.
    const card = settings.locator('.server-settings-bouncer-upstream');
    await expect(card).toHaveAttribute('data-state', 'disconnected');
    await expect(card).toContainText('Network offline');
    await expect(card).toContainText("Your bouncer is reachable but isn't connected to");
    await card.getByRole('button', { name: 'Connect network', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(card).toContainText('Network connected');
    await expect(card).toContainText('Your bouncer is connected to');
    await expect.poll(() => zncOnIrc(zncUser), { timeout: 15_000 }).toBe(true);

    // …and Disconnect network from the card.
    await card.getByRole('button', { name: 'Disconnect network' }).click();
    await expect(card).toHaveAttribute('data-state', 'disconnected', { timeout: 30_000 });
    await expect.poll(() => zncOnIrc(zncUser), { timeout: 15_000 }).toBe(false);
    await settings.getByRole('button', { name: 'Close settings' }).click();

    // Server rail context menu: only "Connect network" while offline.
    await railTile(page, serverName).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Disconnect network' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Connect network', exact: true }).click();
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(sidebar(page).getByLabel('via bouncer', { exact: true })).toBeVisible();
    await expect(strip(page)).toBeHidden();
    await railTile(page, serverName).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Connect network', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Disconnect network' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Auto-connect back ON: after a disconnect + reconnect of the app the
    // bouncer is taken back onto the network without any click.
    await zncUpstream(zncUser, 'disconnect');
    expect(await zncOnIrc(zncUser)).toBe(false);
    settings = await openServerSettings(page, /^Bouncer/);
    await setToggle(settings, AUTO, true);
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Saved — reconnect to apply')).toBeVisible();
    await settings.getByRole('tab', { name: /^Actions/ }).click();
    await settings.getByRole('button', { name: 'Reconnect' }).click();
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(strip(page)).toBeHidden();
    // ZNC really went back on the network — nobody but the app's
    // auto-connect asked it to. (The "connecting" strip can come and go
    // within one frame here, so it isn't asserted.)
    expect(await zncOnIrc(zncUser)).toBe(true);
  });

  test('ZNC replays what was said while the app was closed', async ({ launchApp, zncUser }) => {
    const channel = `#e2e-replay-${uid(8)}`;
    const name = `ZNC Replay ${uid(4)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      await peer.join(channel);
      const first = await launchApp();
      await continueAsGuest(first.page, `rp${uid()}`);
      await configureBouncerProfile(first.page, {
        host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
      });
      await attachBouncerNetwork(first.page, zncUser, name);
      const joinMark = peer.mark();
      await joinChannel(first.page, channel);
      const join = await peer.waitFor(
        (l) => l.command === 'JOIN' && (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
        30_000, 'bouncer JOIN', joinMark,
      );
      const upstreamNick = join.prefix.split('!')[0]!;
      const live = `live ${uid()}`;
      peer.privmsg(channel, live);
      await expect(messageList(first.page).getByText(live)).toBeVisible();

      // Close the app: ZNC stays in the channel for us (no QUIT/PART
      // upstream) and buffers what's said.
      await first.app.close();
      const away = [`while away 1 ${uid()}`, `while away 2 ${uid()}`];
      for (const t of away) peer.privmsg(channel, t);
      // ZNC is still there: the peer sees no QUIT/PART from it.
      expect(peer.lines.some((l) => (l.command === 'QUIT' || l.command === 'PART') && l.prefix.startsWith(`${upstreamNick}!`))).toBe(false);

      // Relaunch: the session restores, re-attaches to ZNC, and ZNC replays
      // the buffer into the channel.
      const second = await launchApp();
      const page = second.page;
      await expect(page.locator('.sidebar-server-name')).toHaveText(name, { timeout: 30_000 });
      await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
      await sidebar(page).getByText(channel.replace(/^#/, ''), { exact: true }).click();
      await expect(composer(page, channel)).toBeVisible();
      for (const t of away) await expect(messageList(page).getByText(t)).toHaveCount(1, { timeout: 20_000 });
      // Order kept.
      const texts = await messageList(page).locator('text=/while away \\d/').allTextContents();
      expect(texts.findIndex((t) => t.includes(away[0]!))).toBeLessThan(texts.findIndex((t) => t.includes(away[1]!)));
      // And the channel is live again.
      const back = `back ${uid()}`;
      await sendMessage(page, channel, back);
      await peer.waitForPrivmsg(channel, back);
    } finally {
      await peer.quit();
    }
  });

  test('upstream changes made behind the app’s back are picked up', async ({ launchApp, zncUser }) => {
    const channel = `#e2e-bnc-ext-${uid(8)}`;
    const name = `ZNC Ext ${uid(4)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      await peer.join(channel);
      const { page } = await launchApp();
      await continueAsGuest(page, `ex${uid()}`);
      await configureBouncerProfile(page, {
        host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
      });
      await attachBouncerNetwork(page, zncUser, name);
      await joinChannel(page, channel);

      // ---- 0. Talking to *status while the upstream is up: its reply is
      // unrecognised, so the engine double-checks with a USERHOST self-probe
      // (~5s later). The network answers it → still connected, and the
      // probe's 302 reply is swallowed rather than shown.
      await composer(page, channel).fill('/msg *status Version');
      await composer(page, channel).press('Enter');
      await expect(page.getByPlaceholder('Message @*status')).toBeVisible();
      // Probe delay + timeout are 5s each; past both, a dropped probe would
      // have flipped the state.
      await page.waitForTimeout(11_000);
      await expect(dot(page)).toHaveAttribute('data-state', 'connected');
      const settings = await openServerSettings(page, /^Log/);
      await expect(settings.locator('.server-settings-log')).toContainText('*status');
      await expect(settings.locator('.server-settings-log')).not.toContainText(/\b302\b/);
      await settings.getByRole('button', { name: 'Close settings' }).click();
      await sidebar(page).getByText(channel.replace(/^#/, ''), { exact: true }).click();
      await expect(composer(page, channel)).toBeVisible();

      // ---- 1. ZNC bounces the upstream (another client: `jump`). Every
      // attached client hears "Disconnected from IRC. Reconnecting…",
      // "Connected!" and the new session's 001 within a second; the engine
      // tracks it (disconnected → connecting → connected) and the app ends
      // up on the new upstream session without any user action. (The
      // round trip is too fast for the strip to paint — not asserted.)
      const rejoin = peer.mark();
      await zncUpstream(zncUser, 'jump');
      await peer.waitFor(
        (l) => l.command === 'JOIN' && (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
        30_000, 'ZNC re-joining after jump', rejoin,
      );
      await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
      await expect(strip(page)).toBeHidden();
      // The channel works over the new upstream session.
      const out1 = `after jump ${uid()}`;
      await sendMessage(page, channel, out1);
      await peer.waitForPrivmsg(channel, out1, 30_000);

      // ---- 2. Another client disconnects the upstream. ZNC tells only
      // that client; the app finds out when its next message bounces
      // ("…got lost, you are not connected to IRC!").
      await zncUpstream(zncUser, 'disconnect');
      const lost = `lost ${uid()}`;
      await sendMessage(page, channel, lost);
      await expect(strip(page)).toHaveAttribute('data-state', 'disconnected', { timeout: 30_000 });
      await expect(dot(page)).toHaveAttribute('data-state', 'upstream-offline');
      // Nothing reached the network.
      expect(peer.lines.some((l) => l.command === 'PRIVMSG' && (l.params[1] ?? '').includes(lost))).toBe(false);
      // The strip's Connect brings it back.
      await strip(page).getByRole('button', { name: 'Connect' }).click();
      await expect(strip(page)).toBeHidden({ timeout: 45_000 });
      await expect(dot(page)).toHaveAttribute('data-state', 'connected');
      const out2 = `reconnected ${uid()}`;
      await sendMessage(page, channel, out2);
      await peer.waitForPrivmsg(channel, out2, 30_000);

      // ---- 3. Disconnected behind its back again; this time the user
      // only talks to *status. Its (unrecognised) reply makes the engine
      // probe the upstream with USERHOST, which ZNC drops while off the
      // network → the app flips to offline without a lost message.
      await zncUpstream(zncUser, 'disconnect');
      await expect(dot(page)).toHaveAttribute('data-state', 'connected');
      await composer(page, channel).fill('/msg *status Version');
      await composer(page, channel).press('Enter');
      await expect(page.getByPlaceholder('Message @*status')).toBeVisible();
      await expect(dot(page)).toHaveAttribute('data-state', 'upstream-offline', { timeout: 30_000 });
    } finally {
      await peer.quit();
    }
  });
});
