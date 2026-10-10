// Local message history (IndexedDB, signed-in users only): what was said in a
// channel is there again after a relaunch — once, not duplicated — and /clear
// erases it for good.
//
// Server-side scrollback ("Load older messages", IRCv3 chathistory) isn't
// covered: the e2e ergo runs with `history.enabled: false`
// (infra/e2e/ergo.yaml), so it never offers the cap.
import { test, expect, randomChannel, loginAs } from './fixtures';
import {
  connectPeer, addServerAndConnect, messages, memberRow, joinViaUi, say, command, waitCmd, conversation,
} from './helpers/chat';
import type { IrcPeer } from './irc-peer';

test.describe('local history', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('messages persist across a relaunch without duplicates; /clear forgets them', async ({ launchApp, account }) => {
    test.setTimeout(240_000);
    const channel = randomChannel('hist');
    const serverName = `History Ergo ${Math.random().toString(16).slice(2, 6)}`;
    const peer = await connectPeer();
    peers.push(peer);

    // ---- launch 1: sign in, connect, talk ----
    const first = await launchApp();
    expect(await loginAs(first.page, account)).toBe('directory');
    await addServerAndConnect(first.page, serverName);
    // Signed in, the IRC nick is the Boson handle.
    const nick = account.handle!;
    await joinViaUi(first.page, channel, nick);
    await expect(first.page.locator('.chat-nick-chip')).toHaveText(nick);
    await peer.join(channel);
    await expect(memberRow(first.page, peer.nick)).toBeVisible();
    peer.privmsg(channel, 'remember me after restart');
    await expect(messages(first.page).getByText('remember me after restart')).toBeVisible();
    await say(first.page, 'my own line, also kept');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'my own line, also kept');
    await first.app.close();

    // ---- launch 2: history is back before anyone says anything ----
    const second = await launchApp();
    const page = second.page;
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await conversation(page, channel).click();
    await expect(messages(page).getByText('remember me after restart')).toHaveCount(1);
    await expect(messages(page).getByText('my own line, also kept')).toHaveCount(1);
    // Live traffic lands after the restored lines.
    peer.privmsg(channel, 'and a new one');
    await expect(messages(page).getByText('and a new one')).toBeVisible();
    const texts = await messages(page).locator('.message-row-text-body').allTextContents();
    expect(texts.indexOf('and a new one')).toBeGreaterThan(texts.indexOf('remember me after restart'));

    // /clear wipes the stored copy as well.
    await command(page, '/clear');
    await expect(messages(page).getByText('remember me after restart')).toHaveCount(0);
    await second.app.close();

    const third = await launchApp();
    await expect(third.page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await conversation(third.page, channel).click();
    await expect(memberRow(third.page, peer.nick)).toBeVisible({ timeout: 30_000 });
    peer.privmsg(channel, 'after the clear');
    await expect(messages(third.page).getByText('after the clear')).toBeVisible();
    await expect(messages(third.page).getByText('remember me after restart')).toHaveCount(0);
    await expect(messages(third.page).getByText('and a new one')).toHaveCount(0);
  });
});
