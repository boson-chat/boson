// Channel operation through the UI: the Channel settings modal (modes, key,
// limit, topic, bans), the right-click nick menu (voice / op / kick / ban /
// DM), and what a non-operator sees — plus the error banner for a join the
// server refuses.
import { test, expect, randomChannel } from './fixtures';
import {
  connectGuest, connectPeer, peerNick, say, conversation, messages, memberRow, members, banner,
  joinViaUi, joinViaCommand, waitCmd, input,
} from './helpers/chat';
import type { IrcPeer } from './irc-peer';

test.describe('channel operation', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('Channel settings: modes, key, limit, topic and bans', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const channel = randomChannel('cset');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();

    await page.getByRole('button', { name: 'Channel settings' }).click();
    const dialog = page.getByRole('dialog', { name: `Channel settings — ${channel}` });
    await expect(dialog).toBeVisible();
    // We created the channel → operator → everything is editable.
    await expect(dialog.getByText('You need channel operator (@) to change these.')).toHaveCount(0);
    // Opening it fetched the ban list.
    await expect(dialog.getByText('No bans set.')).toBeVisible();

    const mode = (modes: string, arg?: string) => waitCmd(peer, 'MODE', nick, (l) =>
      l.params[0] === channel && l.params[1] === modes && (arg === undefined || l.params[2] === arg));
    const toggle = (label: string) => dialog.getByRole('checkbox', { name: label });

    // Boolean modes: the switch flips at once and the server confirms.
    for (const [label, flag] of [
      ['Moderated (+m)', 'm'],
      ['Invite only (+i)', 'i'],
      ['Topic locked (+t)', 't'],
      ['No external messages (+n)', 'n'],
      ['Secret (+s)', 's'],
    ] as const) {
      await expect(toggle(label)).not.toBeChecked();
      await dialog.getByText(label, { exact: true }).click();
      await expect(toggle(label)).toBeChecked();
      await mode(`+${flag}`);
    }
    await dialog.getByText('Moderated (+m)', { exact: true }).click();
    await mode('-m');
    await expect(toggle('Moderated (+m)')).not.toBeChecked();

    // Key: set + clear.
    const keyRow = dialog.locator('.chan-param-row').filter({ hasText: 'Key (+k)' });
    await keyRow.getByRole('textbox').fill('sekrit');
    await keyRow.getByRole('button', { name: 'Set' }).click();
    await mode('+k', 'sekrit');
    await expect(keyRow.getByRole('button', { name: 'Clear' })).toBeEnabled();
    await keyRow.getByRole('button', { name: 'Clear' }).click();
    await mode('-k');

    // Limit: digits only, set + clear.
    const limitRow = dialog.locator('.chan-param-row').filter({ hasText: 'Limit (+l)' });
    await limitRow.getByRole('spinbutton').fill('25');
    await limitRow.getByRole('button', { name: 'Set' }).click();
    await mode('+l', '25');
    await expect(limitRow.getByRole('button', { name: 'Clear' })).toBeEnabled();
    await limitRow.getByRole('button', { name: 'Clear' }).click();
    await mode('-l');

    // Topic.
    const topic = dialog.locator('textarea.chan-topic');
    await expect(dialog.getByRole('button', { name: 'Save topic' })).toBeDisabled();
    await topic.fill('Set from the settings modal');
    await dialog.getByRole('button', { name: 'Save topic' }).click();
    const t = await waitCmd(peer, 'TOPIC', nick);
    expect(t.params).toEqual([channel, 'Set from the settings modal']);
    await expect(page.locator('.chat-channel-topic')).toHaveText('Set from the settings modal');

    // Bans: add one by mask, see it listed, remove it.
    await dialog.getByPlaceholder('nick!user@host').fill('troll!*@*');
    await dialog.getByRole('button', { name: 'Add ban' }).click();
    await mode('+b', 'troll!*@*');
    const banRow = dialog.locator('.chan-ban-row').filter({ hasText: 'troll!*@*' });
    await expect(banRow).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Bans (1)' })).toBeVisible();
    await banRow.getByRole('button', { name: 'Remove' }).click();
    await mode('-b', 'troll!*@*');
    await expect(banRow).toHaveCount(0);

    // Closing + reopening re-reads the server's modes (RPL_CHANNELMODEIS).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Channel settings' }).click();
    await expect(toggle('Secret (+s)')).toBeChecked();
    await expect(toggle('Invite only (+i)')).toBeChecked();
    await expect(toggle('Moderated (+m)')).not.toBeChecked();
  });

  test('a non-operator sees read-only channel settings', async ({ launchApp }) => {
    const channel = randomChannel('ro');
    const owner = await connectPeer(peerNick('own'));
    peers.push(owner);
    await owner.join(channel);
    owner.send(`MODE ${channel} +t`);
    owner.send(`TOPIC ${channel} :owner topic`);
    await owner.waitFor((l) => l.command === 'TOPIC', 15_000, 'TOPIC echo');
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await expect(page.locator('.chat-channel-topic')).toHaveText('owner topic');
    await expect(memberRow(page, owner.nick)).toHaveClass(/user-panel-item-op|user-panel-item-founder/);

    await page.getByRole('button', { name: 'Channel settings' }).click();
    const dialog = page.getByRole('dialog', { name: `Channel settings — ${channel}` });
    await expect(dialog.getByText('You need channel operator (@) to change these.')).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Topic locked (+t)' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Moderated (+m)' })).toBeDisabled();
    await expect(dialog.locator('textarea.chan-topic')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Add ban' })).toBeDisabled();
    await page.keyboard.press('Escape');

    // The nick menu offers no operator actions to a regular member.
    await memberRow(page, owner.nick).click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy nickname', 'Send message']);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('nick context menu: voice, op, ban, kick (+ reason), kick + ban, DM', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const channel = randomChannel('menu');
    const peer = await connectPeer();
    const victim = await connectPeer(peerNick('vic'));
    const victim2 = await connectPeer(peerNick('vic'));
    peers.push(peer, victim, victim2);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    for (const p of [peer, victim, victim2]) await p.join(channel);
    await expect(memberRow(page, victim2.nick)).toBeVisible();
    const menu = page.getByRole('menu');
    const openMenu = async (target: string): Promise<void> => {
      await memberRow(page, target).click({ button: 'right' });
      await expect(menu).toBeVisible();
      await expect(menu.locator('.nick-context-menu-title')).toHaveText(target);
    };
    const mode = (modes: string, arg: string) => waitCmd(peer, 'MODE', nick, (l) =>
      l.params[0] === channel && l.params[1] === modes && l.params[2] === arg);

    await openMenu(victim.nick);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Copy nickname', 'Send message', 'Give voice (+v)', 'Give half-op (+h)', 'Give op (+o)',
      'Kick…', 'Ban', 'Kick + Ban…',
    ]);
    await menu.getByRole('menuitem', { name: 'Give voice (+v)' }).click();
    await expect(menu).toHaveCount(0);
    await mode('+v', victim.nick);
    await expect(memberRow(page, victim.nick)).toHaveClass(/user-panel-item-voice/);

    // The menu reflects the member's current status.
    await openMenu(victim.nick);
    await menu.getByRole('menuitem', { name: 'Take voice (-v)' }).click();
    await mode('-v', victim.nick);
    await openMenu(peer.nick);
    await menu.getByRole('menuitem', { name: 'Give op (+o)' }).click();
    await mode('+o', peer.nick);
    await expect(memberRow(page, peer.nick)).toHaveClass(/user-panel-item-op/);
    await openMenu(peer.nick);
    await expect(menu.getByRole('menuitem', { name: 'Take op (-o)' })).toBeVisible();
    // Outside click closes it.
    await messages(page).click({ position: { x: 10, y: 10 } });
    await expect(menu).toHaveCount(0);

    // Ban: by host (userhost-in-names told us each member's host).
    await openMenu(victim.nick);
    await menu.getByRole('menuitem', { name: 'Ban', exact: true }).click();
    const ban = await waitCmd(peer, 'MODE', nick, (l) => l.params[0] === channel && l.params[1] === '+b');
    expect(ban.params[2]).toMatch(/^\*!\*@.+/);
    // (Every e2e client shares one host, so lift it again before Kick + Ban.)
    await say(page, `/unban ${ban.params[2]}`);
    await mode('-b', ban.params[2]!);

    // Kick… asks for a reason first.
    await openMenu(victim.nick);
    await menu.getByRole('menuitem', { name: 'Kick…' }).click();
    const kickDialog = page.getByRole('dialog', { name: `Kick ${victim.nick}` });
    await expect(kickDialog).toBeVisible();
    await kickDialog.getByPlaceholder('e.g. spamming').fill('flooding');
    await kickDialog.getByRole('button', { name: 'Kick', exact: true }).click();
    const kick = await waitCmd(peer, 'KICK', nick);
    expect(kick.params).toEqual([channel, victim.nick, 'flooding']);
    await expect(memberRow(page, victim.nick)).toHaveCount(0);

    // Kick + Ban… (Cancel first, then for real with no reason).
    await openMenu(victim2.nick);
    await menu.getByRole('menuitem', { name: 'Kick + Ban…' }).click();
    const kbDialog = page.getByRole('dialog', { name: `Kick + Ban ${victim2.nick}` });
    await kbDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(kbDialog).toBeHidden();
    await openMenu(victim2.nick);
    await menu.getByRole('menuitem', { name: 'Kick + Ban…' }).click();
    const mark = peer.mark();
    await kbDialog.getByRole('button', { name: 'Kick + Ban', exact: true }).click();
    const kb = await waitCmd(peer, 'MODE', nick, (l) => l.params[0] === channel && l.params[1] === '+b', mark);
    expect(kb.params[2]).toMatch(/^\*!\*@.+/);
    await waitCmd(peer, 'KICK', nick, (l) => l.params[1] === victim2.nick, mark);
    await expect(memberRow(page, victim2.nick)).toHaveCount(0);

    // "Send message" from a message author's name opens the DM.
    peer.privmsg(channel, 'talk to me');
    const name = messages(page).locator('.message-row').filter({ hasText: 'talk to me' }).locator('.message-row-name');
    await name.click({ button: 'right' });
    await menu.getByRole('menuitem', { name: 'Send message' }).click();
    await expect(page.getByPlaceholder(`Message @${peer.nick}`)).toBeVisible();
    await expect(conversation(page, peer.nick)).toBeVisible();
    await say(page, 'hi from the menu');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[0] === peer.nick && l.params[1] === 'hi from the menu');

    // Copy nickname writes it to the clipboard (stubbed: never touch the
    // developer's real clipboard).
    await page.evaluate(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      navigator.clipboard.writeText = async (t: string) => { w.__copied.push(t); };
    });
    await conversation(page, channel).click();
    await openMenu(peer.nick);
    await menu.getByRole('menuitem', { name: 'Copy nickname' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([peer.nick]);
  });

  test('a join the server refuses shows why and leaves no ghost channel', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const home = randomChannel('home');
    const inviteOnly = randomChannel('inv');
    const keyed = randomChannel('key');
    const full = randomChannel('full');
    const banned = randomChannel('ban');
    const owner = await connectPeer(peerNick('own'));
    peers.push(owner);
    const { page, nick } = await connectGuest(launchApp);
    for (const c of [inviteOnly, keyed, full, banned]) await owner.join(c);
    owner.send(`MODE ${inviteOnly} +i`);
    owner.send(`MODE ${keyed} +k hunter2`);
    owner.send(`MODE ${full} +l 1`);
    owner.send(`MODE ${banned} +b ${nick}!*@*`);
    await owner.waitFor((l) => l.command === 'MODE' && l.params[0] === banned, 15_000, 'ban set');
    await joinViaUi(page, home, nick);

    for (const [chan, why] of [
      [inviteOnly, /Cannot join channel \(\+i\)/],
      [keyed, /Cannot join channel \(\+k\)/],
      [full, /Cannot join channel \(\+l\)/],
      [banned, /Cannot join channel \(\+b\)/],
    ] as const) {
      await say(page, `/join ${chan}`);
      await expect(banner(page)).toContainText(`Cannot join ${chan}:`, { timeout: 45_000 });
      await expect(banner(page)).toContainText(why);
      await expect(conversation(page, chan)).toHaveCount(0);
      // Back on the channel we were in.
      await expect(page.getByPlaceholder(`Message #${home.slice(1)}`)).toBeVisible();
      await banner(page).getByRole('button', { name: 'Dismiss' }).click();
    }

    // An invite gets us into the +i channel; the right key into the +k one.
    owner.send(`INVITE ${nick} ${inviteOnly}`);
    await expect.poll(() => owner.lines.some((l) => l.command === '341'), { timeout: 15_000 }).toBe(true);
    await joinViaCommand(page, inviteOnly, nick);
    await expect(members(page).getByText(owner.nick, { exact: true })).toBeVisible();
    await say(page, `/raw JOIN ${keyed} hunter2`);
    await expect(conversation(page, keyed)).toBeVisible({ timeout: 45_000 });
    await expect(input(page)).toBeVisible();
  });
});
