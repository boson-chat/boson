// Quoted replies (IRCv3 `+draft/reply`, a client-only tag ergo relays to
// clients with message-tags), against the e2e ergo: Reply on a message sends
// the next line with the original's msgid and, for clients that don't read
// the tag, `nick: ` (or `nick: "quote..." `) in front of it, which Boson
// hides; an incoming reply shows a quote of its original (a click scrolls
// to it), or says the original isn't available.
import { test, expect, randomChannel } from './fixtures';
import { connectGuest, connectPeer, joinViaUi, memberRow, messages, say, waitCmd } from './helpers/chat';
import type { IrcPeer } from './irc-peer';

test.describe('replies', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('reply to a message and see replies quoted', async ({ launchApp }) => {
    const channel = randomChannel('reply');
    // echo-message: the peer learns its own lines' msgids.
    const peer = await connectPeer(undefined, ['message-tags', 'echo-message']);
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    // By its own text (a reply's quote holds its original's too).
    const row = (text: string) => messages(page).locator('.message-row')
      .filter({ has: page.locator('.message-row-text-body', { hasText: text }) });

    // The peer asks; the echo carries the msgid the server gave it.
    let mark = peer.mark();
    peer.privmsg(channel, 'q1 which port does it listen on?');
    const echo = await peer.waitFor((l) => l.command === 'PRIVMSG' && l.params[1] === 'q1 which port does it listen on?', 15_000, 'echo', mark);
    const questionId = echo.tags['msgid'];
    expect(questionId).toBeTruthy();
    await expect(row('q1 which port')).toBeVisible();

    // Reply from the message's hover toolbar: the composer says who to.
    await row('q1 which port').hover();
    await row('q1 which port').getByRole('button', { name: 'Reply', exact: true }).click();
    const bar = page.locator('.chat-reply-bar');
    await expect(bar).toContainText(`Replying to ${peer.nick}`);
    await expect(bar).toContainText('q1 which port does it listen on?');
    mark = peer.mark();
    await say(page, 'a1 6697, with TLS');
    await expect(bar).toHaveCount(0);
    // The question is the peer's latest line: just its nick in front.
    const sent = await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === `${peer.nick}: a1 6697, with TLS`, mark);
    expect(sent.tags['+draft/reply']).toBe(questionId);
    // Shown without the `nick: ` its quote stands for.
    await expect(row('a1 6697').locator('.message-row-text-body')).toHaveText('a1 6697, with TLS');
    // Our own line shows the quote too.
    await expect(row('a1 6697').locator('.message-reply-quote')).toContainText(peer.nick);
    await expect(row('a1 6697').locator('.message-reply-quote-text')).toHaveText('q1 which port does it listen on?');

    // echo-message: our line came back with the server's msgid, which it
    // now carries (one line, not two), so it can be replied to — by us…
    const ownId = sent.tags['msgid'];
    expect(ownId).toBeTruthy();
    await expect(row('a1 6697')).toHaveCount(1);
    await row('a1 6697').hover();
    await row('a1 6697').getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(bar).toContainText(`Replying to ${nick}`);
    mark = peer.mark();
    await say(page, 'a2 and 6667 is going away');
    const ownReply = await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === `${nick}: a2 and 6667 is going away`, mark);
    expect(ownReply.tags['+draft/reply']).toBe(ownId);
    await expect(row('a2 and 6667').locator('.message-row-text-body')).toHaveText('a2 and 6667 is going away');
    await expect(row('a2 and 6667').locator('.message-reply-quote-author')).toHaveText(nick);
    // …and by others: their reply quotes our line (its own text, without
    // the prefix).
    peer.send(`@+draft/reply=${ownId} PRIVMSG ${channel} :r0 thanks`);
    await expect(row('r0 thanks').locator('.message-reply-quote-author')).toHaveText(nick);
    await expect(row('r0 thanks').locator('.message-reply-quote-text')).toHaveText('a1 6697, with TLS');

    // A classic client's reply (no tag): read back from its text, the
    // quoted form shown as a reply with the prefix hidden.
    peer.privmsg(channel, `${nick}: "a1..." r0b and TLS only`);
    await expect(row('r0b and TLS only').locator('.message-reply-quote-text')).toHaveText('a1 6697, with TLS');
    await expect(row('r0b and TLS only').locator('.message-row-text-body')).toHaveText('r0b and TLS only');

    // Escape cancels a reply in progress; the next line is plain.
    await row('q1 which port').hover();
    await row('q1 which port').getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(bar).toBeVisible();
    await page.locator('textarea.chat-textarea').press('Escape');
    await expect(bar).toHaveCount(0);

    // An incoming reply: quoted; a click on the quote scrolls to the original.
    for (let i = 0; i < 40; i++) peer.privmsg(channel, `filler ${i} ${'lorem ipsum '.repeat(4)}`);
    await expect(row('filler 39')).toBeVisible();
    peer.send(`@+draft/reply=${questionId} PRIVMSG ${channel} :r1 and the admin port is 8080`);
    const reply = row('r1 and the admin port');
    await expect(reply.locator('.message-reply-quote-author')).toHaveText(peer.nick);
    await expect(reply.locator('.message-reply-quote-text')).toHaveText('q1 which port does it listen on?');
    await expect(row('q1 which port')).not.toBeInViewport();
    await reply.locator('.message-reply-quote').click();
    await expect(row('q1 which port')).toBeInViewport();
    await expect(page.locator('.vrow-flash')).toContainText('q1 which port');

    // Threads: the replies to q1, and to those replies, make one thread
    // (a1, a2, r0, r0b, r1); its line under q1 opens it beside the chat.
    const threadLine = row('q1 which port').locator('.message-thread-line');
    await expect(threadLine).toContainText('5 replies');
    await threadLine.click();
    const panel = page.locator('.thread-panel');
    await expect(panel.locator('.message-row')).toHaveCount(6);
    await expect(panel.locator('.chat-reply-bar')).toContainText(`Replying to ${peer.nick}`);
    // Sent from the panel: an ordinary reply on the wire (tag + text).
    mark = peer.mark();
    await panel.locator('textarea.chat-textarea').fill('t1 from the thread');
    await panel.locator('textarea.chat-textarea').press('Enter');
    const inThread = await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1]!.startsWith(`${peer.nick}: `) && l.params[1]!.endsWith('t1 from the thread'), mark);
    expect(inThread.tags['+draft/reply']).toBeTruthy();
    await expect(panel.locator('.message-row')).toHaveCount(7);
    await expect(threadLine).toContainText('6 replies');
    await panel.getByRole('button', { name: 'Close thread' }).click();
    await expect(panel).toHaveCount(0);

    // A reply to a message that isn't loaded says so (back at the bottom:
    // the list only renders the rows on screen).
    await messages(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(row('r1 and the admin port')).toBeInViewport();
    peer.send(`@+draft/reply=not-a-real-msgid PRIVMSG ${channel} :r2 replying to something older`);
    // (Asked for with CHATHISTORY AROUND first; the server hasn't it.)
    await expect(row('r2 replying').locator('.message-reply-quote')).toHaveText('Original message not available', { timeout: 15_000 });
  });
});
