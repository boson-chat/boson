// The composer: slash / @mention / #channel autocomplete, nick Tab-complete,
// multi-line input, sent-message history, the emoji picker and the outgoing
// IRCv3 typing indicator — driven by the keyboard against the e2e ergo, with
// raw IRC peers asserting what actually reached the wire.
import { test, expect, randomChannel } from './fixtures';
import {
  connectGuest, connectPeer, peerNick, say, input, conversation, messages, memberRow,
  joinViaUi, joinViaCommand, waitCmd,
} from './helpers/chat';
import type { IrcPeer } from './irc-peer';

test.describe('composer', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('slash-command autocomplete: filter, arrows, Tab cycling, Enter, Escape, click', async ({ launchApp }) => {
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, randomChannel('ac'), nick);
    const box = input(page);
    const popup = page.getByRole('listbox', { name: 'Slash command autocomplete' });
    const options = popup.getByRole('option');

    // Typing filters by name and alias.
    await box.fill('/jo');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('/join <channel>');
    await expect(options.first()).toContainText('Join a channel');
    await box.fill('/qu');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('/msg <nick> <text>'); // `query` aliases msg

    // Arrows move the selection (wrapping); Enter accepts it.
    await box.fill('/wh');
    await expect(options).toHaveCount(3); // whois, whowas, who
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await box.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await box.press('ArrowUp');
    await box.press('ArrowUp');
    await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
    await box.press('Enter');
    await expect(box).toHaveValue('/who ');
    await expect(popup).toHaveCount(0);

    // Tab completes the first match, then cycles through the rest.
    await box.fill('/m');
    await expect(options.first()).toContainText('/msg');
    await box.press('Tab');
    await expect(box).toHaveValue('/msg ');
    await box.press('Tab');
    await expect(box).toHaveValue('/me ');
    await box.press('Tab');
    await expect(box).toHaveValue('/motd ');

    // Escape hides the popup but keeps the text; editing re-arms it.
    await box.fill('/he');
    await expect(popup).toBeVisible();
    await box.press('Escape');
    await expect(popup).toHaveCount(0);
    await expect(box).toHaveValue('/he');
    await box.press('l');
    await expect(popup).toBeVisible();

    // Mouse pick (hover selects, mousedown accepts).
    await box.fill('/to');
    await options.filter({ hasText: '/topic' }).hover();
    await options.filter({ hasText: '/topic' }).click();
    await expect(box).toHaveValue('/topic ');
    await expect(box).toBeFocused();
  });

  test('@mention, #channel and bare-nick completion; mentions are sent without the @', async ({ launchApp }) => {
    const prefix = `cmp${Math.random().toString(16).slice(2, 6)}`;
    const chanA = randomChannel(prefix);
    const chanB = randomChannel(prefix);
    const alice = await connectPeer(peerNick('zed'));
    const albert = await connectPeer(peerNick('zed'));
    peers.push(alice, albert);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, chanB, nick);
    await joinViaCommand(page, chanA, nick);
    await alice.join(chanA);
    await albert.join(chanA);
    await expect(memberRow(page, alice.nick)).toBeVisible();
    await expect(memberRow(page, albert.nick)).toBeVisible();
    const [first, second] = [alice.nick, albert.nick].sort((a, b) => a.localeCompare(b));
    const box = input(page);

    // @ opens the member popup, filtered by prefix, sorted.
    const mention = page.getByRole('listbox', { name: 'Mention autocomplete' });
    await box.fill('hey @ze');
    await expect(mention.getByRole('option')).toHaveText([`@${first}`, `@${second}`]);
    await box.press('ArrowDown');
    await box.press('Enter');
    await expect(box).toHaveValue(`hey @${second} `);
    // Tab from the popup arms a cycle; Tab again swaps to the next member.
    await box.fill('hey @ze');
    await box.press('Tab');
    await expect(box).toHaveValue(`hey @${first} `);
    await box.press('Tab');
    await expect(box).toHaveValue(`hey @${second} `);
    // Escape closes the popup (appends a space).
    await box.fill('cc @ze');
    await box.press('Escape');
    await expect(mention).toHaveCount(0);
    await expect(box).toHaveValue('cc @ze ');

    // A sent mention reaches IRC as the bare nick, and the peer is pinged.
    await box.fill('');
    await box.pressSequentially(`ping @${first.slice(0, 5)}`);
    await mention.getByRole('option').filter({ hasText: first }).click();
    await box.pressSequentially('can you see this');
    await box.press('Enter');
    const got = await waitCmd(alice, 'PRIVMSG', nick, (l) => l.params[0] === chanA);
    expect(got.params[1]).toBe(`ping ${first} can you see this`);
    // …and renders with the nick highlighted as a member mention.
    const sent = messages(page).locator('.message-row').filter({ hasText: 'can you see this' });
    await expect(sent.locator('.chat-token-mention')).toHaveText(first);

    // #channel completion over the joined channels. (Park the mouse: a popup
    // opening under the pointer would hover-select an entry.)
    await page.mouse.move(0, 0);
    const chans = page.getByRole('listbox', { name: 'Channel autocomplete' });
    await box.fill(`see #${prefix}`);
    await expect(chans.getByRole('option')).toHaveCount(2);
    const [c1, c2] = [chanA, chanB].sort((a, b) => a.localeCompare(b));
    await box.press('Tab');
    await expect(box).toHaveValue(`see ${c1} `);
    await box.press('Tab');
    await expect(box).toHaveValue(`see ${c2} `);
    await box.fill(`see #${prefix}`);
    await box.press('Enter');
    await expect(box).toHaveValue(`see ${c1} `);
    // Mouse pick.
    await box.fill(`also #${prefix}`);
    await chans.getByRole('option').nth(1).click();
    await expect(box).toHaveValue(`also ${c2} `);
    await box.fill(`and #${prefix}`);
    await box.press('Escape');
    await expect(box).toHaveValue(`and #${prefix} `);

    // Bare nick + Tab: at the start of a line it becomes "nick: ", and Tab
    // again cycles to the next match; mid-line it's just the nick.
    await box.fill('ze');
    await box.press('Tab');
    await expect(box).toHaveValue(`${first}: `);
    await box.press('Tab');
    await expect(box).toHaveValue(`${second}: `);
    await box.fill(`thanks ${second.slice(0, -1)}`);
    await box.press('Tab');
    await expect(box).toHaveValue(`thanks ${second}`);
    // No member matches → Tab is left alone (focus moves on).
    await box.fill('qqqq');
    await box.press('Tab');
    await expect(box).toHaveValue('qqqq');
  });

  test('Shift+Enter writes multi-line messages; Up/Down recall sent lines', async ({ launchApp }) => {
    const channel = randomChannel('ml');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    const box = input(page);

    // Shift+Enter → newline; Enter sends one PRIVMSG per line.
    await box.click();
    await box.pressSequentially('line one');
    await box.press('Shift+Enter');
    await box.pressSequentially('line two');
    await expect(box).toHaveValue('line one\nline two');
    await box.press('Enter');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'line one');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'line two');
    await expect(messages(page).getByText('line one')).toBeVisible();
    await expect(messages(page).getByText('line two')).toBeVisible();
    // Consecutive lines from one sender are grouped under one header.
    await expect(messages(page).locator('.message-row-grouped').filter({ hasText: 'line two' })).toBeVisible();

    // The Send button sends too.
    await box.fill('via the button');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'via the button');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

    // History: Up walks back through what was sent, Down walks forward and
    // finally restores the unsent draft.
    await box.fill('a draft');
    await box.press('ArrowUp');
    await expect(box).toHaveValue('via the button');
    await box.press('ArrowUp');
    await expect(box).toHaveValue('line one\nline two');
    // The caret sits at the end (last line), so Down steps forward again.
    await box.press('ArrowDown');
    await expect(box).toHaveValue('via the button');
    await box.press('ArrowDown');
    await expect(box).toHaveValue('a draft');
    // Recalled text can be re-sent.
    await box.fill('');
    await box.press('ArrowUp');
    await box.press('Enter');
    await expect.poll(() => peer.lines.filter((l) => l.command === 'PRIVMSG' && l.params[1] === 'via the button').length, { timeout: 45_000 }).toBe(2);
  });

  test('emoji picker inserts at the caret; :shortcodes: render as emoji', async ({ launchApp }) => {
    const channel = randomChannel('emo');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    const box = input(page);

    await box.fill('launch !');
    // Caret before the "!".
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
    await page.getByRole('button', { name: 'Insert emoji' }).click();
    const picker = page.getByRole('dialog', { name: 'Emoji picker' });
    await expect(picker).toBeVisible();
    await picker.getByPlaceholder('Search…').fill('rock');
    await expect(picker.getByRole('button', { name: ':rocket:' })).toBeVisible();
    await picker.getByRole('button', { name: ':rocket:' }).click();
    await expect(picker).toBeHidden();
    await expect(box).toHaveValue('launch 🚀!');
    await expect(box).toBeFocused();

    // No matches; Escape and outside-click both close.
    await page.getByRole('button', { name: 'Insert emoji' }).click();
    await picker.getByPlaceholder('Search…').fill('zzzznope');
    await expect(picker.getByText('No matches')).toBeVisible();
    await picker.getByPlaceholder('Search…').press('Escape');
    await expect(picker).toBeHidden();
    await page.getByRole('button', { name: 'Insert emoji' }).click();
    await expect(picker).toBeVisible();
    await messages(page).click({ position: { x: 20, y: 20 } });
    await expect(picker).toBeHidden();

    await box.press('Enter');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'launch 🚀!');

    // A peer's :shortcode: renders as the emoji; unknown codes stay literal.
    peer.privmsg(channel, 'ship it :fire: :tada: :notacode:');
    const row = messages(page).locator('.message-row').filter({ hasText: 'ship it' });
    await expect(row.getByRole('img', { name: 'fire' })).toHaveText('🔥');
    await expect(row.getByRole('img', { name: 'tada' })).toHaveText('🎉');
    await expect(row).toContainText(':notacode:');
  });

  test('typing sends +typing=active then done to the channel', async ({ launchApp }) => {
    const channel = randomChannel('typ');
    const peer = await connectPeer(peerNick(), ['message-tags']);
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();

    const mark = peer.mark();
    await input(page).click();
    await input(page).pressSequentially('typing something');
    const active = await waitCmd(peer, 'TAGMSG', nick, (l) => l.params[0] === channel && l.tags['+typing'] === 'active', mark);
    expect(active.tags['+typing']).toBe('active');
    await input(page).press('Enter');
    await waitCmd(peer, 'TAGMSG', nick, (l) => l.params[0] === channel && l.tags['+typing'] === 'done', mark);
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'typing something', mark);

    // Slash commands never broadcast typing.
    const mark2 = peer.mark();
    await say(page, '/help');
    await expect(page.getByRole('dialog', { name: 'Slash commands' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Slash commands' })).toBeHidden();
    await say(page, 'after the command');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'after the command', mark2);
    await waitCmd(peer, 'TAGMSG', nick, (l) => l.tags['+typing'] === 'done', mark2);
    const typings = peer.lines.slice(mark2).filter((l) => l.command === 'TAGMSG');
    // Only the "after the command" line's typing states — none for /help. The
    // engine may skip the "active" when the line is sent before the rate
    // budget allows it (a queued "active" is superseded by the message itself;
    // see engine/irc/sendqueue.go), so it's optional; "done" always follows.
    const states = typings.map((l) => l.tags['+typing']);
    expect([['active', 'done'], ['done']]).toContainEqual(states);
    await expect(conversation(page, channel)).toBeVisible();
  });
});
