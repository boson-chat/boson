// Slash commands typed into the composer, against the e2e ergo with a raw IRC
// peer on the other side: every command must reach the wire (asserted on the
// peer) and its outcome must show in the app.
import { test, expect, randomChannel } from './fixtures';
import {
  connectGuest, connectPeer, peerNick, say, command, input, conversation, messages, memberRow, members,
  banner, joinViaCommand, joinViaUi, waitCmd,
} from './helpers/chat';
import type { IrcPeer } from './irc-peer';

const ACTION = '\x01';

test.describe('slash commands', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('/join /me /msg /query /topic /nick /part reach IRC and render', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const channel = randomChannel('cmd');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);

    // Into a first channel through the sidebar, then /join from its composer.
    // The app creates the channel, so it is the channel's operator.
    const lobby = randomChannel('lobby');
    await joinViaUi(page, lobby, nick);
    await joinViaCommand(page, channel, nick);
    await expect(conversation(page, lobby)).toBeVisible();
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    await expect(messages(page).getByText(`${peer.nick} joined`)).toBeVisible();

    // /me → CTCP ACTION on the wire, an action row in the app.
    await say(page, '/me waves at everyone');
    const action = await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[0] === channel);
    expect(action.params[1]).toBe(`${ACTION}ACTION waves at everyone${ACTION}`);
    await expect(page.locator('.message-action-mine')).toContainText(`${nick}waves at everyone`);

    // A peer's ACTION renders as an action too.
    peer.privmsg(channel, `${ACTION}ACTION dances${ACTION}`);
    await expect(page.locator('.message-action').filter({ hasText: 'dances' })).toContainText(peer.nick);

    // /topic <text> → TOPIC on the wire; header + inline system line.
    await say(page, '/topic Release day, be nice');
    const topic = await waitCmd(peer, 'TOPIC', nick);
    expect(topic.params).toEqual([channel, 'Release day, be nice']);
    await expect(page.locator('.chat-channel-topic')).toHaveText('Release day, be nice');
    await expect(messages(page).getByText(`${nick} changed the topic to: Release day, be nice`)).toBeVisible();
    // /topic with no text asks the server (RPL_TOPIC); the header keeps it.
    await command(page, '/topic');
    await expect(page.locator('.chat-channel-topic')).toHaveText('Release day, be nice');

    // /msg <nick> <text> → a DM tab with the line; the peer gets a PRIVMSG.
    await say(page, `/msg ${peer.nick} psst, over here`);
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[0] === peer.nick && l.params[1] === 'psst, over here');
    await expect(conversation(page, peer.nick)).toBeVisible();
    await expect(page.getByPlaceholder(`Message @${peer.nick}`)).toBeVisible();
    await expect(messages(page).getByText('psst, over here')).toBeVisible();
    // The peer answers in the DM.
    peer.privmsg(nick, 'what is it?');
    await expect(messages(page).getByText('what is it?')).toBeVisible();

    // Back to the channel, then /query <nick> (no text) just opens the DM.
    await conversation(page, channel).click();
    await expect(page.getByPlaceholder(`Message #${channel.slice(1)}`)).toBeVisible();
    await say(page, `/query ${peer.nick}`);
    await expect(page.getByPlaceholder(`Message @${peer.nick}`)).toBeVisible();
    await conversation(page, channel).click();

    // /nick → NICK on the wire; the composer chip and member list follow.
    const newNick = peerNick('ren');
    await say(page, `/nick ${newNick}`);
    await waitCmd(peer, 'NICK', nick, (l) => l.params[0] === newNick);
    await expect(page.locator('.chat-nick-chip')).toHaveText(newNick);
    await expect(memberRow(page, newNick)).toBeVisible();
    await expect(memberRow(page, nick)).toHaveCount(0);

    // A line from the renamed self is sent under the new nick.
    await say(page, 'still me');
    await waitCmd(peer, 'PRIVMSG', newNick, (l) => l.params[1] === 'still me');

    // `//text` escapes a literal leading slash.
    await say(page, '//shrug is not a command');
    await waitCmd(peer, 'PRIVMSG', newNick, (l) => l.params[1] === '/shrug is not a command');
    await expect(messages(page).getByText('/shrug is not a command')).toBeVisible();

    // /part → PART on the wire; the channel leaves the sidebar.
    const mark = peer.mark();
    await command(page, '/part');
    await waitCmd(peer, 'PART', newNick, (l) => l.params[0] === channel, mark);
    await expect(conversation(page, channel)).toHaveCount(0);
  });

  test('channel-operator commands: /op /voice /halfop /kick /ban /unban /invite /mode', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const channel = randomChannel('ops');
    const peer = await connectPeer();
    const bystander = await connectPeer(peerNick('by'));
    peers.push(peer, bystander);
    const { page, nick } = await connectGuest(launchApp);

    await joinViaUi(page, channel, nick);
    // The creator holds channel-operator status.
    await expect(members(page).locator('.user-panel-group-header').first()).toHaveText(/^(Founders|Operators) — 1$/);
    await peer.join(channel);
    await bystander.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();

    const modeFrom = (_target: string, modes: string, arg?: string) => waitCmd(bystander, 'MODE', nick, (l) =>
      l.params[0] === channel && l.params[1] === modes && (arg === undefined || l.params[2] === arg),
    );

    await say(page, `/voice ${peer.nick}`);
    await modeFrom(channel, '+v', peer.nick);
    await expect(members(page).getByText('Voiced — 1')).toBeVisible();
    await expect(memberRow(page, peer.nick)).toHaveClass(/user-panel-item-voice/);

    await say(page, `/devoice ${peer.nick}`);
    await modeFrom(channel, '-v', peer.nick);
    await expect(members(page).getByText('Voiced — 1')).toHaveCount(0);

    await say(page, `/halfop ${peer.nick}`);
    await modeFrom(channel, '+h', peer.nick);
    await expect(memberRow(page, peer.nick)).toHaveClass(/user-panel-item-halfop/);

    await say(page, `/op ${peer.nick}`);
    await modeFrom(channel, '+o', peer.nick);
    await expect(memberRow(page, peer.nick)).toHaveClass(/user-panel-item-op/);
    // The run of joins + mode changes folds into one collapsible summary.
    const activity = messages(page).locator('.message-activity').last();
    await expect(activity.locator('.message-activity-summary')).toContainText('· and');
    await activity.getByRole('button').click();
    await expect(activity.locator('.message-activity-lines')).toContainText(`${nick} sets mode +o ${peer.nick}`);
    await expect(activity.locator('.message-activity-lines')).toContainText(`${nick} sets mode +v ${peer.nick}`);

    await say(page, `/deop ${peer.nick}`);
    await modeFrom(channel, '-o', peer.nick);

    // A role badge appears next to a privileged speaker's messages.
    await say(page, `/op ${peer.nick}`);
    await modeFrom(channel, '+o', peer.nick);
    peer.privmsg(channel, 'I have the power');
    const row = messages(page).locator('.message-row').filter({ hasText: 'I have the power' });
    await expect(row.locator('.message-row-role')).toHaveText('OPS');

    // /mode passthrough: channel flags.
    await say(page, `/mode ${channel} +m`);
    await modeFrom(channel, '+m');
    await expect(messages(page).getByText(`${nick} sets mode +m`).last()).toBeAttached();

    // /ban <nick> → nick!*@*; /unban the same.
    await say(page, `/ban ${bystander.nick}`);
    await modeFrom(channel, '+b', `${bystander.nick}!*@*`);
    await say(page, `/unban ${bystander.nick}`);
    await modeFrom(channel, '-b', `${bystander.nick}!*@*`);

    // /invite <nick> [#channel] → INVITE delivered to the target.
    const outsider = await connectPeer(peerNick('out'));
    peers.push(outsider);
    await say(page, `/invite ${outsider.nick}`);
    const inv = await waitCmd(outsider, 'INVITE', nick);
    expect(inv.params).toEqual([outsider.nick, channel]);

    // /kick <nick> <reason> → KICK; the app renders it and drops the member.
    await say(page, `/kick ${bystander.nick} be nice`);
    const kick = await waitCmd(peer, 'KICK', nick);
    expect(kick.params).toEqual([channel, bystander.nick, 'be nice']);
    await expect(messages(page).getByText(`${nick} kicked ${bystander.nick} (be nice)`)).toBeVisible();
    await expect(memberRow(page, bystander.nick)).toHaveCount(0);
  });

  test('server queries and /raw go to the server; usage errors show a banner', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const channel = randomChannel('q');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);

    // Usage errors: a dismissible banner above the composer, nothing sent.
    for (const [line, text] of [
      ['/whois', 'Usage: /whois <nick>'],
      ['/whowas', 'Usage: /whowas <nick>'],
      ['/who', 'Usage: /who <#channel-or-mask>'],
      ['/mode', 'Usage: /mode <target> <+/-modes> [args]'],
      ['/oper', 'Usage: /oper <name> <password>'],
      ['/raw', 'Usage: /raw <IRC line>'],
      ['/kick', 'Usage: /kick <nick> [reason]'],
      ['/ban', 'Usage: /ban <nick|mask>'],
      ['/unban', 'Usage: /unban <mask>'],
      ['/op', 'Usage: /op <nick>'],
      ['/invite', 'Usage: /invite <nick> [#channel]'],
      ['/msg', 'Usage: /msg <nick> [message]'],
      ['/nick', 'Usage: /nick <new-nick>'],
      ['/join', 'Usage: /join <channel>'],
      ['/me', 'Usage: /me <action>'],
      ['/frobnicate', 'Unknown command: /frobnicate. Try /help.'],
    ] as const) {
      await command(page, line);
      await expect(banner(page)).toHaveText(new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    await banner(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner(page)).toHaveCount(0);

    // /raw sends the line verbatim.
    await say(page, `/raw PRIVMSG ${peer.nick} :raw hello`);
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[0] === peer.nick && l.params[1] === 'raw hello');

    // Info queries round-trip through the server; their replies land in the
    // server's raw event log (Server details → Log).
    await say(page, `/whois ${peer.nick}`);
    await say(page, `/who ${channel}`);
    await say(page, `/whowas nobody${peer.nick}`);
    for (const c of ['/motd', '/lusers', '/version', '/admin', '/time', '/links', '/list', `/list ${channel}`]) {
      await command(page, c);
    }
    await say(page, '/oper nobody wrongpass');

    await page.getByRole('button', { name: 'Server details' }).click();
    await page.getByRole('tab', { name: /^Log/ }).click();
    // (Replies trail the commands: the engine paces outgoing lines.)
    const kinds = page.locator('.server-settings-log-kind');
    // RPL_WHOISUSER (311) for the peer, RPL_ENDOFWHO (315), RPL_VERSION (351),
    // RPL_TIME (391), ERR_PASSWDMISMATCH / ERR_NOOPERHOST for the bad /oper.
    for (const kind of ['311', '315', '351', '391']) {
      await expect(kinds.filter({ hasText: new RegExp(`^${kind}$`) }).first()).toBeAttached({ timeout: 60_000 });
    }
    await expect(kinds.filter({ hasText: /^(464|491)$/ }).first()).toBeAttached({ timeout: 60_000 });
  });

  test('/help lists commands; /clear empties the log; /away and /back', async ({ launchApp }) => {
    const channel = randomChannel('misc');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await peer.join(channel);

    await command(page, '/help');
    const help = page.getByRole('dialog', { name: 'Slash commands' });
    await expect(help).toBeVisible();
    await expect(help.getByText('/join <channel>')).toBeVisible();
    await expect(help.getByText('/raw <IRC line>')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();

    peer.privmsg(channel, 'something to clear');
    await expect(messages(page).getByText('something to clear')).toBeVisible();
    await command(page, '/clear');
    await expect(messages(page).getByText('something to clear')).toHaveCount(0);

    // /away <msg> → AWAY on the wire (the peer sees it via WHOIS), confirmed
    // in the channel; /back clears it.
    await say(page, '/away lunch');
    await expect(messages(page).getByText('You are now marked as away.')).toBeVisible();
    peer.send(`WHOIS ${nick}`);
    const away = await peer.waitFor((l) => l.command === '301' && l.params[1] === nick, 15_000, 'RPL_AWAY');
    expect(away.params[2]).toBe('lunch');
    await command(page, '/back');
    await expect(messages(page).getByText('You are no longer marked as away.')).toBeVisible();
    await expect(input(page)).toHaveValue('');
  });
});
