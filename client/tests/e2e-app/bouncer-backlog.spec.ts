// Backlog from the bouncer: what was said while the app was away (closed,
// or its engine gone) shows up once it attaches to ZNC again, in the right
// conversation, in order, once.
import { execFileSync } from 'node:child_process';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  test, expect, uid, IRC_HOST, IRC_PORT, type ZncUser,
  continueAsGuest, configureBouncerProfile, joinChannel,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import { conversation, messages } from './helpers/chat';
import { withZncAdmin } from './helpers/znc-admin';
import { electronOnly } from './wails-shell';

async function joinViaBouncer(page: Page, peer: IrcPeer, z: ZncUser, name: string, channel: string): Promise<string> {
  await continueAsGuest(page, `bl${uid()}`);
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

test.describe('bouncer backlog', () => {
  test('what was said while the app was closed is there on the next launch', async ({ launchApp, zncUser }) => {
    test.setTimeout(240_000);
    const channel = `#e2e-backlog-${uid(8)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      await peer.join(channel);
      const first = await launchApp();
      const nick = await joinViaBouncer(first.page, peer, zncUser, `ZNC Backlog ${uid(4)}`, channel);
      await first.app.close();

      const lines = [`missed one ${uid()}`, `missed two ${uid()}`, `missed three ${uid()}`];
      for (const l of lines) peer.privmsg(channel, l);
      const dm = `a private word ${uid()}`;
      peer.privmsg(nick, dm);
      // Let ZNC buffer them before the app attaches again.
      await new Promise((r) => setTimeout(r, 1_500));

      const { page } = await launchApp();
      await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
      await conversation(page, channel).click();
      for (const l of lines) await expect(messages(page).getByText(l)).toHaveCount(1, { timeout: 30_000 });
      const texts = await messages(page).locator('.message-row-text-body').allTextContents();
      const at = lines.map((l) => texts.indexOf(l));
      expect(at).toEqual([...at].sort((a, b) => a - b));

      await conversation(page, peer.nick).click();
      await expect(messages(page).getByText(dm)).toHaveCount(1, { timeout: 30_000 });
    } finally {
      await peer.quit();
    }
  });

  test('what was said while the connection was down is there once it is back', async ({ launchApp, zncUser }) => {
    electronOnly('it kills the engine sidecar; the engine is in-process under Wails');
    test.setTimeout(240_000);
    const channel = `#e2e-gap-${uid(8)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    try {
      await peer.join(channel);
      const { app, page } = await launchApp();
      const nick = await joinViaBouncer(page, peer, zncUser, `ZNC Gap ${uid(4)}`, channel);
      const before = `before the drop ${uid()}`;
      peer.privmsg(channel, before);
      await expect(messages(page).getByText(before)).toHaveCount(1);

      // The engine dies without a QUIT; ZNC keeps buffering for us.
      process.kill(enginePid(app), 'SIGKILL');
      await expect(page.locator('.sidebar-status-dot')).not.toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
      const gap = `during the drop ${uid()}`;
      peer.privmsg(channel, gap);
      const dm = `while you were gone ${uid()}`;
      peer.privmsg(nick, dm);

      await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
      await conversation(page, channel).click();
      await expect(messages(page).getByText(gap)).toHaveCount(1, { timeout: 30_000 });
      await expect(messages(page).getByText(before)).toHaveCount(1);
      const texts = await messages(page).locator('.message-row-text-body').allTextContents();
      expect(texts.indexOf(before)).toBeLessThan(texts.indexOf(gap));
      await conversation(page, peer.nick).click();
      await expect(messages(page).getByText(dm)).toHaveCount(1, { timeout: 30_000 });
    } finally {
      await peer.quit();
    }
  });

  // A ZNC with AutoClearChanBuffer / AutoClearQueryBuffer off keeps its
  // buffers and replays all of them on every attach, read or not. That is
  // the only way a plain ZNC (no playback module, no chathistory) gives back
  // history, and replaying it every time must not stack up repeats.
  test('a ZNC that keeps its buffers gives back what was already read, every launch, once', async ({ launchApp, zncUser }) => {
    test.setTimeout(300_000);
    const set = (on: boolean) => withZncAdmin(zncUser, async (run) => {
      for (const k of ['AutoClearChanBuffer', 'AutoClearQueryBuffer']) {
        const reply = (await run('*controlpanel', `Set ${k} ${zncUser.username} ${on}`)).join(' ');
        expect(reply).toMatch(new RegExp(`${k} = ${on}`, 'i'));
      }
    });
    const channel = `#e2e-keep-${uid(8)}`;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    await set(false);
    try {
      await peer.join(channel);
      const first = await launchApp();
      const nick = await joinViaBouncer(first.page, peer, zncUser, `ZNC Kept ${uid(4)}`, channel);
      const read = [`read live one ${uid()}`, `read live two ${uid()}`];
      for (const l of read) peer.privmsg(channel, l);
      const dmRead = `private, read live ${uid()}`;
      peer.privmsg(nick, dmRead);
      for (const l of read) await expect(messages(first.page).getByText(l)).toHaveCount(1);
      await first.app.close();

      const missed = `said while closed ${uid()}`;
      peer.privmsg(channel, missed);
      await new Promise((r) => setTimeout(r, 1_500));

      // Twice: the second launch gets the same full replay again.
      for (let launch = 0; launch < 2; launch++) {
        const { app, page } = await launchApp();
        await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
        await conversation(page, channel).click();
        for (const l of [...read, missed]) await expect(messages(page).getByText(l)).toHaveCount(1, { timeout: 30_000 });
        const texts = await messages(page).locator('.message-row-text-body').allTextContents();
        const at = [...read, missed].map((l) => texts.indexOf(l));
        expect(at).toEqual([...at].sort((a, b) => a - b));
        await conversation(page, peer.nick).click();
        await expect(messages(page).getByText(dmRead)).toHaveCount(1, { timeout: 30_000 });
        await app.close();
      }
    } finally {
      await set(true).catch(() => {});
      await peer.quit();
    }
  });

  // A plain ZNC has no history command, but with its buffers kept it
  // replays them whole on attach (up to ChanBufferSize lines). The app holds
  // 1500 per conversation in view and keeps the rest for scroll-up, so
  // "Load older messages" walks back to the start of ZNC's buffer.
  test('scroll-up reaches the start of a long ZNC buffer', async ({ launchApp, zncUser }) => {
    test.setTimeout(300_000);
    const settings = (on: { clear: boolean; size: number }) => withZncAdmin(zncUser, async (run) => {
      for (const k of ['AutoClearChanBuffer', 'AutoClearQueryBuffer']) {
        expect((await run('*controlpanel', `Set ${k} ${zncUser.username} ${on.clear}`)).join(' ')).toMatch(new RegExp(`${k} = ${on.clear}`, 'i'));
      }
      expect((await run('*controlpanel', `Set ChanBufferSize ${zncUser.username} ${on.size}`)).join(' ')).toMatch(new RegExp(`ChanBufferSize = ${on.size}`, 'i'));
    });
    const channel = `#e2e-long-${uid(8)}`;
    const tag = uid(4);
    const N = 1700;
    const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `peer${uid()}` });
    await settings({ clear: false, size: 2000 });
    try {
      await peer.join(channel);
      const first = await launchApp();
      await joinViaBouncer(first.page, peer, zncUser, `ZNC Long ${uid(4)}`, channel);
      await first.app.close();

      for (let i = 0; i < N; i++) peer.privmsg(channel, `bulk ${tag} ${i}`);
      // Wait until ZNC has the last of them buffered (a probe client would
      // replay it; instead give ergo + ZNC a moment, then check the app).
      await new Promise((r) => setTimeout(r, 3_000));

      const { page } = await launchApp();
      await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
      await conversation(page, channel).click();
      const line = (i: number) => messages(page).getByText(`bulk ${tag} ${i}`, { exact: true });
      await expect(line(N - 1)).toHaveCount(1, { timeout: 60_000 });
      await expect(line(0)).toHaveCount(0);

      const older = page.getByRole('button', { name: 'Load older messages' });
      const start = messages(page).getByText('Beginning of history');
      for (let n = 0; n < 20 && (await start.count()) === 0; n++) {
        await expect(older.or(start)).toBeVisible({ timeout: 10_000 });
        if (await older.isVisible()) await older.click();
        await page.waitForTimeout(300);
      }
      await expect(start).toBeVisible();
      await expect(line(0)).toHaveCount(1);
      const bodies = await messages(page).locator('.message-row-text-body').allTextContents();
      const bulk = bodies.filter((t) => t.startsWith(`bulk ${tag} `));
      expect(bulk).toHaveLength(N);
      expect(bulk.map((t) => Number(t.split(' ')[2]))).toEqual([...Array(N).keys()]);
    } finally {
      await settings({ clear: true, size: 50 }).catch(() => {});
      await peer.quit();
    }
  });
});
