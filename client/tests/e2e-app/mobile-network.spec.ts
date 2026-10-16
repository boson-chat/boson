// A phone's network, misbehaving (the mobile project: iPhone viewport, touch).
// What was sent shows greyed, "Sending…", until the server confirms it; a
// slow network is just slow (no reconnect, no strip); a dead or missing one
// gets noticed, reconnected, and what was sent goes out after all — once.
import type { Page } from '@playwright/test';
import { test, expect, randomChannel, joinChannel } from './fixtures';
import { connectGuest, connectPeer, messages, say } from './helpers/chat';
import { startNetProxy, type NetProxy } from './helpers/net-proxy';
import type { IrcPeer } from './irc-peer';

const row = (page: Page, text: string) => messages(page).locator('.message-row', { hasText: text });
const strip = (page: Page) => page.locator('.chat-connection-strip');

async function expectPending(page: Page, text: string): Promise<void> {
  await expect(row(page, text)).toHaveClass(/message-row-pending/);
  await expect(row(page, text)).toContainText('Sending…');
  // Visibly greyed, not just tagged.
  const opacity = await row(page, text).locator('.message-row-text').evaluate((e) => Number(getComputedStyle(e).opacity));
  expect(opacity).toBeLessThan(1);
}

async function expectSent(page: Page, peer: IrcPeer, channel: string, text: string, mark: number, timeout: number): Promise<void> {
  await peer.waitFor((l) => l.command === 'PRIVMSG' && l.params[0] === channel && l.params[1] === text, timeout, text, mark);
  await expect(row(page, text)).not.toHaveClass(/message-row-pending/, { timeout: 30_000 });
  await expect(row(page, text)).toHaveCount(1);
  // Once on the wire too.
  await new Promise((r) => setTimeout(r, 1500));
  expect(peer.lines.slice(mark).filter((l) => l.command === 'PRIVMSG' && l.params[1] === text)).toHaveLength(1);
}

test.describe('phone network', () => {
  let proxy: NetProxy;
  let peer: IrcPeer;
  test.beforeEach(async () => { proxy = await startNetProxy(); peer = await connectPeer(); });
  test.afterEach(async () => { await peer.quit(); await proxy.close(); });

  async function setup(launchApp: Parameters<Parameters<typeof test>[1]>[0]['launchApp']) {
    const { page } = await connectGuest(launchApp, { port: proxy.port });
    const channel = randomChannel('net');
    await joinChannel(page, channel);
    await peer.join(channel);
    return { page, channel };
  }

  test('a slow network: greyed while it travels, then sent — no reconnect', async ({ launchApp }) => {
    test.setTimeout(90_000);
    const { page, channel } = await setup(launchApp);
    proxy.latencyMs = 1200; // 2.4s round trip
    const mark = peer.mark();
    await say(page, 'over a slow link');
    await expectPending(page, 'over a slow link');
    await expectSent(page, peer, channel, 'over a slow link', mark, 20_000);
    await expect(strip(page)).toHaveCount(0);
  });

  test('no network: greyed, the strip after a few seconds, sent once it is back', async ({ launchApp }) => {
    test.setTimeout(120_000);
    const { page, channel } = await setup(launchApp);
    proxy.refuse = true;
    proxy.drop();
    await say(page, 'typed with no signal');
    await expectPending(page, 'typed with no signal');
    // Quiet at first; the strip once the reconnect is taking a while.
    await expect(strip(page)).toContainText(/Reconnecting…|Connecting…|Disconnected/, { timeout: 15_000 });
    const mark = peer.mark();
    proxy.refuse = false;
    await expectSent(page, peer, channel, 'typed with no signal', mark, 60_000);
    await expect(strip(page)).toHaveCount(0, { timeout: 30_000 });
  });

  test('a dead link (Wi-Fi gone, socket silent): noticed in seconds, then sent', async ({ launchApp }) => {
    test.setTimeout(120_000);
    const { page, channel } = await setup(launchApp);
    const mark = peer.mark();
    proxy.stallLive();
    await say(page, 'into a dead socket');
    await expectPending(page, 'into a dead socket');
    // Probed after 4s unconfirmed, dropped after 5s more, reconnected.
    await expectSent(page, peer, channel, 'into a dead socket', mark, 45_000);
  });
});
