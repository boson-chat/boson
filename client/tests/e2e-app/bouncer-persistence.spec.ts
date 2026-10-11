// A bouncer keeps you on the network: whatever happens to the app's own
// connection to ZNC — the app quits, the engine dies without a word, the
// user leaves the server — ZNC stays on ergo and in its channels. Checked
// from the network's side (a plain peer on ergo: no QUIT / PART from the
// bouncer's nick, and WHOIS / NAMES still list it), after a settle period
// so a late QUIT can't slip past. Only "Disconnect network" (bouncer.spec)
// takes ZNC off the network.
import { execFileSync } from 'node:child_process';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  test, expect, uid, IRC_HOST, IRC_PORT, type ZncUser,
  continueAsGuest, configureBouncerProfile, joinChannel,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import { railContextMenu, railTile } from './helpers/directory';
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
});
