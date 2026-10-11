// A bouncer keeps you on the network: whatever happens to the app's own
// connection to ZNC — the app quits, the engine dies without a word, the
// user leaves the server — ZNC stays on ergo and in its channels. Checked
// from the network's side (a plain peer on ergo: no QUIT / PART from the
// bouncer's nick, and WHOIS / NAMES still list it), after a settle period
// so a late QUIT can't slip past. Only "Disconnect network" (bouncer.spec)
// takes ZNC off the network.
import { execFileSync } from 'node:child_process';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import {
  test, expect, uid, IRC_HOST, IRC_PORT, type ZncUser, field,
  continueAsGuest, configureBouncerProfile, joinChannel, addServerManually, serverCard, sendMessage,
} from './fixtures';
import { IrcPeer, type IrcLine } from './irc-peer';
import { openServerSettings, railContextMenu, railTile } from './helpers/directory';
import { zncOnIrc } from './helpers/znc-admin';

// How long to keep watching for a QUIT / PART after the app's connection to
// ZNC went away. ZNC acts on a client QUIT or a closed socket at once, so
// this is generous.
const SETTLE_MS = 3_000;

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, SETTLE_MS));

// Guest → bouncer profile → Directory → Bouncer tab → add + connect the
// user's ZNC network, wait for auto-connect to take it onto ergo, and join
// `channel` through it. Returns the bouncer's nick on ergo.
async function joinViaBouncer(page: Page, peer: IrcPeer, z: ZncUser, name: string, channel: string): Promise<string> {
  await continueAsGuest(page, `bp${uid()}`);
  await configureBouncerProfile(page, { host: z.host, port: z.port, username: z.username, password: z.password, tls: false });
  await page.getByRole('tab', { name: 'Bouncer' }).click();
  await page.getByPlaceholder('Display name').fill(name);
  await page.getByPlaceholder('ZNC network, e.g. libera').fill(z.network);
  await page.getByRole('button', { name: 'Add network' }).click();
  await page.locator('.directory-bouncer-row').filter({ hasText: name })
    .getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });

  const mark = peer.mark();
  await joinChannel(page, channel);
  const join = await peer.waitFor(
    (l) => l.command === 'JOIN' && (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(),
    30_000, `bouncer joining ${channel}`, mark,
  );
  return join.prefix.split('!')[0]!;
}

// The bouncer's nick is still on ergo and in `channel`, and the peer saw no
// QUIT / PART from it since `since`.
async function expectStillOnNetwork(peer: IrcPeer, z: ZncUser, nick: string, channel: string, since: number): Promise<void> {
  await settle();
  const left = peer.lines.slice(since).filter((l) =>
    (l.command === 'QUIT' || l.command === 'PART' || l.command === 'KICK') && l.prefix.split('!')[0] === nick);
  expect(left.map((l) => l.raw)).toEqual([]);
  const who = await peer.whois(nick);
  expect(who.online).toBe(true);
  expect(who.channels).toContain(channel.toLowerCase());
  expect(await peer.names(channel)).toContain(nick.toLowerCase());
  expect(await zncOnIrc(z)).toBe(true);
}

const ROUTE = 'Route this server through the bouncer';
const strip = (page: Page) => page.locator('.chat-bouncer-upstream-banner');
const dot = (page: Page) => page.locator('.sidebar-status-dot');

async function setToggle(scope: Locator, label: string, want: boolean): Promise<void> {
  const box = scope.getByRole('checkbox', { name: label, exact: true });
  if ((await box.isChecked()) !== want) await scope.getByText(label, { exact: true }).click();
  await expect(box).toBeChecked({ checked: want });
}

// Server settings → Bouncer: set the route toggle, save, and Reconnect from
// the Actions tab (what a user does to apply it).
async function routeAndReconnect(page: Page, serverName: string, route: boolean, network: string): Promise<void> {
  const settings = await openServerSettings(page, serverName);
  await settings.getByRole('tab', { name: /^Bouncer/ }).click();
  await setToggle(settings, ROUTE, route);
  if (route) await field(settings, 'ZNC network name').fill(network);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings.getByText('Saved — reconnect to apply')).toBeVisible();
  await settings.getByRole('tab', { name: /^Actions/ }).click();
  await settings.getByRole('button', { name: 'Reconnect' }).click();
  await settings.getByRole('button', { name: 'Close settings' }).click();
}

// User settings → Bouncer: switch the global profile on or off.
async function setBouncerEnabled(page: Page, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await dialog.getByRole('tab', { name: /^Bouncer/ }).click();
  await setToggle(dialog, 'Use a bouncer', on);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Saved', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
}

const nickOf = (l: IrcLine): string => l.prefix.split('!')[0]!;
const joined = (channel: string) => (l: IrcLine): boolean =>
  l.command === 'JOIN' && (l.params[0] ?? '').toLowerCase() === channel.toLowerCase();

// PID of the engine sidecar the app's main process spawned.
function enginePid(app: ElectronApplication): number {
  const main = app.process().pid!;
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
  for (const row of rows) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
    if (m && Number(m[2]) === main && /engine-[a-z]+-[a-z0-9]+/.test(m[3]!)) return Number(m[1]);
  }
  throw new Error(`no engine child of Electron main process ${main}`);
}

test.describe('bouncer keeps you on the network', () => {
  test('closing the app detaches from ZNC; ZNC stays on the network and in the channel', async ({ launchApp, zncUser }) => {
    const channel = `#e2e-keep-${uid(8)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      await peer.join(channel);
      const { app, page } = await launchApp();
      const nick = await joinViaBouncer(page, peer, zncUser, `ZNC Keep ${uid(4)}`, channel);

      const mark = peer.mark();
      await app.close();
      await expectStillOnNetwork(peer, zncUser, nick, channel, mark);
    } finally {
      await peer.quit();
    }
  });

  test('the engine dying without a QUIT leaves ZNC on the network', async ({ launchApp, zncUser }) => {
    const channel = `#e2e-crash-${uid(8)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      await peer.join(channel);
      const { app, page } = await launchApp();
      const nick = await joinViaBouncer(page, peer, zncUser, `ZNC Crash ${uid(4)}`, channel);

      const mark = peer.mark();
      process.kill(enginePid(app), 'SIGKILL');
      // The app notices its engine is gone.
      await expect(page.locator('.sidebar-status-dot')).not.toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
      await expectStillOnNetwork(peer, zncUser, nick, channel, mark);
    } finally {
      await peer.quit();
    }
  });

  test('Leave server detaches from ZNC without leaving the network', async ({ launchApp, zncUser }) => {
    const channel = `#e2e-leave-${uid(8)}`;
    const name = `ZNC Leave ${uid(4)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      await peer.join(channel);
      const { page } = await launchApp();
      const nick = await joinViaBouncer(page, peer, zncUser, name, channel);

      const mark = peer.mark();
      await (await railContextMenu(page, name)).getByRole('menuitem', { name: 'Leave server' }).click();
      await expect(railTile(page, name)).toHaveCount(0);
      await expectStillOnNetwork(peer, zncUser, nick, channel, mark);
    } finally {
      await peer.quit();
    }
  });

  // Turning the bouncer off (per server, or the whole profile) and
  // reconnecting must really reconnect directly: a fresh connection under
  // the app's own nick, no bouncer strip, no leftover upstream state. ZNC
  // itself stays on the network, as always. And back on again goes through
  // ZNC. Regression: Reconnect used to re-adopt the closing bouncer session
  // when the engine's confirmation came later than the app waited.
  test('turning the bouncer off connects directly, and back on goes through ZNC', async ({ launchApp, zncUser }) => {
    const channel = `#e2e-route-${uid(8)}`;
    const serverName = `Route Ergo ${uid(4)}`;
    const guest = `rt${uid()}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      await peer.join(channel);
      const { page } = await launchApp();
      await continueAsGuest(page, guest);
      await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name: serverName, tls: false });
      await serverCard(page, serverName).getByRole('button', { name: 'Connect' }).click();
      await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
      await configureBouncerProfile(page, {
        host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
      });

      // Through ZNC: the channel is joined by ZNC's nick.
      await routeAndReconnect(page, serverName, true, zncUser.network);
      await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
      let mark = peer.mark();
      await joinChannel(page, channel);
      const viaZnc = nickOf(await peer.waitFor(joined(channel), 30_000, 'JOIN through ZNC', mark));
      expect(viaZnc.toLowerCase()).not.toBe(guest.toLowerCase());

      // Route off → Reconnect: direct, under the app's own nick, rejoining
      // the saved channel. Nothing bouncer-ish left on screen.
      mark = peer.mark();
      await routeAndReconnect(page, serverName, false, zncUser.network);
      const direct = nickOf(await peer.waitFor(
        (l) => joined(channel)(l) && nickOf(l) !== viaZnc, 45_000, 'direct JOIN', mark));
      expect(direct.toLowerCase()).toContain(guest.toLowerCase());
      await expect(dot(page)).toHaveAttribute('data-state', 'connected');
      await expect(strip(page)).toHaveCount(0);
      const settings = await openServerSettings(page, serverName);
      await settings.getByRole('tab', { name: /^Bouncer/ }).click();
      await expect(settings.locator('.server-settings-bouncer-upstream')).toHaveCount(0);
      await settings.getByRole('button', { name: 'Close settings' }).click();
      const out = `direct ${uid()}`;
      await sendMessage(page, channel, out);
      expect(nickOf(await peer.waitForPrivmsg(channel, out))).toBe(direct);
      // ZNC stayed on the network and in the channel.
      await expectStillOnNetwork(peer, zncUser, viaZnc, channel, mark);

      // Route back on → through ZNC again; the direct connection quits.
      mark = peer.mark();
      await routeAndReconnect(page, serverName, true, zncUser.network);
      await peer.waitFor((l) => l.command === 'QUIT' && nickOf(l) === direct, 30_000, 'direct QUIT', mark);
      await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
      await expect(strip(page)).toBeHidden();
      const back = `via znc again ${uid()}`;
      await sendMessage(page, channel, back);
      expect(nickOf(await peer.waitForPrivmsg(channel, back))).toBe(viaZnc);

      // Whole profile off: the connection re-routes direct by itself (no
      // Reconnect needed)…
      mark = peer.mark();
      await setBouncerEnabled(page, false);
      const direct2 = nickOf(await peer.waitFor(
        (l) => joined(channel)(l) && nickOf(l) !== viaZnc, 45_000, 'direct JOIN (profile off)', mark));
      expect(direct2.toLowerCase()).toContain(guest.toLowerCase());
      await expect(dot(page)).toHaveAttribute('data-state', 'connected');
      await expect(strip(page)).toHaveCount(0);
      await expectStillOnNetwork(peer, zncUser, viaZnc, channel, mark);

      // …and back on: through ZNC again.
      mark = peer.mark();
      await setBouncerEnabled(page, true);
      await peer.waitFor((l) => l.command === 'QUIT' && nickOf(l) === direct2, 45_000, 'direct QUIT (profile on)', mark);
      await expect(dot(page)).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
      const again = `profile back on ${uid()}`;
      await sendMessage(page, channel, again);
      expect(nickOf(await peer.waitForPrivmsg(channel, again))).toBe(viaZnc);
    } finally {
      await peer.quit();
    }
  });
});
