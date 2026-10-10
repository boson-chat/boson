// What other people do, as the app sees it: joins / parts / quits / kicks /
// nick and topic changes, DMs, unread + mention badges, desktop
// notifications, typing indicators and away status — all produced by raw IRC
// peers against the e2e ergo.
import type { Page } from '@playwright/test';
import { test, expect, randomChannel } from './fixtures';
import {
  connectGuest, connectPeer, peerNick, say, conversation, messages, memberRow, members,
  joinViaUi, joinViaCommand, waitCmd, sidebar, escapeRe,
} from './helpers/chat';
import type { IrcPeer } from './irc-peer';

// Membership churn folds into collapsible "activity" summaries once a run is
// long enough; expand them all so every event line is in the DOM.
async function expectEvent(page: Page, text: string): Promise<void> {
  await expect(async () => {
    const collapsed = messages(page).locator('.message-activity-toggle[aria-expanded="false"]');
    for (let i = await collapsed.count(); i > 0; i--) await collapsed.first().click();
    await expect(messages(page).getByText(text, { exact: true })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000 });
}

test.describe('channel events from others', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('joins, topic + nick changes, parts, quits and kicks render and update the member list', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const channel = randomChannel('ev');
    const alice = await connectPeer(peerNick('al'));
    const bob = await connectPeer(peerNick('bo'));
    const carol = await connectPeer(peerNick('ca'));
    peers.push(alice, bob, carol);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);

    await alice.join(channel);
    await bob.join(channel);
    await carol.join(channel);
    await expectEvent(page, `${alice.nick} joined`);
    await expect(members(page).locator('.user-panel-title')).toHaveText('Members — 4');

    // Topic set + cleared by someone else (no +t on the e2e ergo).
    alice.send(`TOPIC ${channel} :peer topic here`);
    await expect(page.locator('.chat-channel-topic')).toHaveText('peer topic here');
    await expectEvent(page, `${alice.nick} changed the topic to: peer topic here`);
    alice.send(`TOPIC ${channel} :`);
    await expectEvent(page, `${alice.nick} cleared the topic`);
    await expect(page.locator('.chat-channel-topic')).toHaveCount(0);

    // Nick change: the member list follows.
    const aliceNew = peerNick('al2');
    alice.send(`NICK ${aliceNew}`);
    await expect(memberRow(page, aliceNew)).toBeVisible();
    await expect(memberRow(page, alice.nick)).toHaveCount(0);

    // Part with no message, quit with a reason.
    bob.send(`PART ${channel}`);
    await expectEvent(page, `${bob.nick} left`);
    await expect(memberRow(page, bob.nick)).toHaveCount(0);
    await carol.quit('see you all');
    await expectEvent(page, `${carol.nick} quit (Quit: see you all)`);
    await expect(memberRow(page, carol.nick)).toHaveCount(0);
    await expect(members(page).locator('.user-panel-title')).toHaveText('Members — 2');

    // Opped by the app, the renamed alice kicks a newcomer…
    const dave = await connectPeer(peerNick('da'));
    peers.push(dave);
    await dave.join(channel);
    await expect(memberRow(page, dave.nick)).toBeVisible();
    await say(page, `/op ${aliceNew}`);
    await expect(memberRow(page, aliceNew)).toHaveClass(/user-panel-item-op/, { timeout: 45_000 });
    alice.send(`KICK ${channel} ${dave.nick} :off you go`);
    await expectEvent(page, `${aliceNew} kicked ${dave.nick} (off you go)`);
    await expect(memberRow(page, dave.nick)).toHaveCount(0);

    // …and then the app itself: the channel leaves the sidebar.
    alice.send(`KICK ${channel} ${nick} :your turn`);
    await expect(conversation(page, channel)).toHaveCount(0);
    await expect(page.getByText('Select a channel from the sidebar, or join one to start chatting.')).toBeVisible();
  });

  test('DMs, unread + mention badges, channel switching and desktop notifications', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const home = randomChannel('home');
    const other = randomChannel('other');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick, serverName } = await connectGuest(launchApp);
    await joinViaUi(page, other, nick);
    await joinViaCommand(page, home, nick);
    await peer.join(home);
    await peer.join(other);
    await expect(memberRow(page, peer.nick)).toBeVisible();

    // Desktop notifications: stub the renderer's Notification API and put the
    // window "in the background" (the notifier only alerts when unfocused).
    await page.evaluate(() => {
      const w = window as unknown as {
        __notes: Array<{ title: string; body: string; n: { onclick: null | (() => void) } }>;
        Notification: unknown;
      };
      w.__notes = [];
      class FakeNotification {
        static permission = 'granted';
        static requestPermission(): Promise<string> { return Promise.resolve('granted'); }
        onclick: null | (() => void) = null;
        constructor(title: string, opts: { body: string }) { w.__notes.push({ title, body: opts.body, n: this }); }
        close(): void { /* noop */ }
      }
      w.Notification = FakeNotification;
      window.dispatchEvent(new Event('blur'));
    });
    const notes = (): Promise<Array<{ title: string; body: string }>> =>
      page.evaluate(() => (window as unknown as { __notes: Array<{ title: string; body: string }> }).__notes
        .map(({ title, body }) => ({ title, body })));

    // A plain message in a background channel: unread dot, no mention, no
    // notification (default settings: mentions + DMs only).
    peer.privmsg(other, 'just chatting');
    const otherRow = conversation(page, other);
    await expect(otherRow.getByLabel(`1 unread message in ${other}`)).toBeVisible();
    peer.privmsg(other, 'still chatting');
    await expect(otherRow.getByLabel(`2 unread messages in ${other}`)).toBeVisible();

    // A mention: mention badge + a notification naming sender, channel, server.
    peer.privmsg(other, `${nick}: are you there?`);
    await expect(otherRow.getByLabel(`1 mention in ${other}`)).toHaveText('1');
    await expect(otherRow).toHaveClass(/channel-item-mention/);
    // (Guest connections have no persistence scope, so the server's name may
    // be missing from the title; when present it must be this server.)
    const titled = (prefix: string): RegExp => new RegExp(`^${escapeRe(prefix)}( · ${escapeRe(serverName)})?$`);
    await expect.poll(notes).toHaveLength(1);
    expect((await notes())[0]!.title).toMatch(titled(`${peer.nick} · ${other}`));
    expect((await notes())[0]!.body).toBe(`${nick}: are you there?`);

    // Switching to it clears the badges; the mention is highlighted.
    await otherRow.click();
    await expect(otherRow).not.toHaveClass(/channel-item-unread|channel-item-mention/);
    const mentionRow = messages(page).locator('.message-row-mention').filter({ hasText: 'are you there?' });
    await expect(mentionRow.locator('.mention-self')).toHaveText(nick);

    // An incoming DM opens a Direct Messages entry that counts as a mention,
    // and raises a DM notification.
    peer.privmsg(nick, 'private word');
    await expect(sidebar(page).getByText('Direct Messages')).toBeVisible();
    const dm = conversation(page, peer.nick);
    await expect(dm.getByLabel(`1 mention in ${peer.nick}`)).toBeVisible();
    await expect.poll(notes).toHaveLength(2);
    expect((await notes())[1]!.title).toMatch(titled(peer.nick));
    expect((await notes())[1]!.body).toBe('private word');

    // Clicking the notification brings the user to that conversation.
    await page.evaluate(() => {
      const w = window as unknown as { __notes: Array<{ n: { onclick: null | (() => void) } }> };
      w.__notes.at(-1)!.n.onclick?.();
    });
    await expect(page.getByPlaceholder(`Message @${peer.nick}`)).toBeVisible();
    await expect(messages(page).getByText('private word')).toBeVisible();

    // Reply from the DM; the peer gets it.
    await say(page, 'private reply');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[0] === peer.nick && l.params[1] === 'private reply');

    // Messages to the channel being viewed don't bump it.
    await conversation(page, home).click();
    peer.privmsg(home, 'in plain view');
    await expect(messages(page).getByText('in plain view')).toBeVisible();
    await expect(conversation(page, home)).not.toHaveClass(/channel-item-unread/);

    // Leaving the DM via its ×.
    await dm.getByRole('button', { name: `Leave ${peer.nick}` }).click();
    await expect(conversation(page, peer.nick)).toHaveCount(0);
  });

  test('typing indicators, away status and member hover cards', async ({ launchApp }) => {
    const channel = randomChannel('pres');
    const alice = await connectPeer(peerNick('al'), ['message-tags']);
    const bob = await connectPeer(peerNick('bo'), ['message-tags']);
    peers.push(alice, bob);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await alice.join(channel);
    await bob.join(channel);
    await expect(memberRow(page, bob.nick)).toBeVisible();
    const typing = page.locator('.chat-typing');

    await expect(typing).toHaveAttribute('data-active', '0');
    alice.send(`@+typing=active TAGMSG ${channel}`);
    await expect(typing).toHaveAttribute('data-active', '1');
    await expect(typing).toContainText(`${alice.nick} is typing`);
    bob.send(`@+typing=active TAGMSG ${channel}`);
    await expect(typing).toContainText(`${alice.nick} and ${bob.nick} are typing`);
    bob.send(`@+typing=done TAGMSG ${channel}`);
    await expect(typing).toContainText(`${alice.nick} is typing`);
    // A real message from the typer clears it.
    alice.privmsg(channel, 'done typing');
    await expect(typing).toHaveAttribute('data-active', '0');

    // Typing in a DM shows in that conversation.
    bob.privmsg(nick, 'hi there');
    await conversation(page, bob.nick).click();
    bob.send(`@+typing=active TAGMSG ${nick}`);
    await expect(typing).toContainText(`${bob.nick} is typing`);
    bob.send(`@+typing=paused TAGMSG ${nick}`);
    await expect(typing).toHaveAttribute('data-active', '0');
    await conversation(page, channel).click();

    // away-notify: the member list shows away/online live.
    alice.send('AWAY :out for lunch');
    await expect(memberRow(page, alice.nick)).toHaveClass(/user-panel-item-away/);
    await expect(memberRow(page, alice.nick).getByLabel('Away')).toBeVisible();

    // Hover card: role, host, away message.
    await memberRow(page, alice.nick).hover();
    const card = page.getByRole('tooltip');
    await expect(card).toContainText(alice.nick);
    await expect(card).toContainText('Member');
    await expect(card).toContainText('out for lunch');
    await expect(card).toContainText(/Host/);
    await page.mouse.move(0, 0);
    await expect(card).toHaveCount(0);

    // Our own row: the channel creator is an operator.
    await memberRow(page, nick).hover();
    await expect(page.getByRole('tooltip')).toContainText('Operator');
    await page.mouse.move(0, 0);

    // Messaging an away user: the server answers RPL_AWAY with their message.
    await say(page, `/msg ${alice.nick} are you back?`);
    await waitCmd(alice, 'PRIVMSG', nick, (l) => l.params[1] === 'are you back?');
    await conversation(page, channel).click();
    await expect(memberRow(page, alice.nick)).toHaveClass(/user-panel-item-away/);

    alice.send('AWAY');
    await expect(memberRow(page, alice.nick)).toHaveClass(/user-panel-item-online/);

    // Hovering a message author shows the same kind of card.
    await messages(page).locator('.message-row-name', { hasText: alice.nick }).hover();
    await expect(page.getByRole('tooltip')).toContainText(alice.nick);
  });
});
