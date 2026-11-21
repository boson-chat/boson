// The notifications bell (title bar), which took over the cross-server
// Inbox: MemoServ memos, DMs and mentions (with friend and call events).
//
// Ergo has no MemoServ (and refuses *Serv nicks), so the memo flow runs
// against MemoNet (helpers/services.ts): a minimal in-process IRC server whose
// services speak Anope. The app must LIST on the "new memos" notice, turn rows
// into Inbox entries, fetch a body with READ only when the user opens one, and
// run Advanced → Memos commands with the reply shown inline.
import type { Page } from '@playwright/test';
import {
  test, expect, IRC_HOST, IRC_PORT, composer, joinChannel, messageList, randomChannel, randomNick, uid,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import { MemoNet, guestOnErgo, openServerSettings, servicesBadge } from './helpers/services';

function inboxButton(page: Page) {
  return page.locator('button.title-bar-bell');
}

async function openInbox(page: Page) {
  await inboxButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Notifications' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('MemoServ memos: listed on login, body fetched on open, dismissed, deleted via Advanced', async ({ launchApp }) => {
  const nick = randomNick('memo');
  const body1 = `memo body ${uid()}`;
  const memoNet = await MemoNet.start([
    { from: 'alice', date: 'Oct 10 12:00:00 2026 UTC', text: body1, unread: true },
    { from: 'bob', date: 'Oct 09 08:30:00 2026 UTC', text: 'older, already read', unread: false },
  ]);
  try {
    const { page } = await launchApp();
    const serverName = `MemoNet ${uid(4)}`;
    await guestOnErgo(page, nick, { host: memoNet.host, port: memoNet.port, name: serverName });
    await memoNet.waitForClient(nick);
    await expect(inboxButton(page)).toHaveAccessibleName('Notifications');

    // Login-time "You have 1 new memo." → the app LISTs (it doesn't READ).
    memoNet.announce(nick);
    await memoNet.waitForCommand(/^LIST$/);
    await expect(inboxButton(page)).toHaveAccessibleName('Notifications, 1 unread');
    expect(memoNet.memoCommands).toEqual(['LIST']);

    const inbox = await openInbox(page);
    const rows = inbox.locator('li.notes-item');
    await expect(rows).toHaveCount(2);
    const alice = rows.filter({ hasText: 'alice' });
    await expect(alice.locator('.bds-row-title')).toHaveText('Memo from alice');
    await expect(alice.locator('.notes-time')).toHaveText('Oct 10 12:00:00 2026 UTC');
    await expect(alice.getByText('Click to read →')).toBeVisible();
    // Unread first, with a dot.
    await expect(rows.first()).toContainText('alice');
    await expect(alice.locator('.notes-dot')).toBeVisible();
    // Attributed to the server's display name (guests get it via the chat
    // service's server scope, not only the 005 NETWORK= name).
    await expect(alice.locator('.bds-row-meta')).toHaveText(serverName);
    expect(memoNet.memoCommands).toEqual(['LIST']);

    // Opening the memo fetches its body in place: READ 1.
    const openAlice = alice.locator('button.bds-row-main');
    await expect(openAlice).toHaveAccessibleName(/Read memo$/);
    await openAlice.click();
    await memoNet.waitForCommand(/^READ 1$/);
    await expect(alice.locator('.bds-row-sub')).toHaveText(body1);
    await expect(alice.getByText('Click to read →')).toBeHidden();

    // Mark all read clears the badge (locally, not on the server).
    await inbox.getByRole('button', { name: 'Mark all read' }).click();
    await expect(inboxButton(page)).toHaveAccessibleName('Notifications');

    // Removing one is local only.
    await alice.getByRole('button', { name: 'Remove Memo from alice' }).click();
    await expect(rows).toHaveCount(1);
    expect(memoNet.memoCommands.filter((c) => c.startsWith('DEL'))).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(inbox).toBeHidden();

    // The engine's services probe classified MemoNet's Anope banner.
    const settings = await openServerSettings(page, 'Identity');
    await expect(servicesBadge(settings)).toHaveText('Anope');

    // Advanced → Memos: DEL runs on the server and the reply shows inline.
    await settings.getByRole('tab', { name: /^Advanced/ }).click();
    await settings.getByRole('tab', { name: 'Memos' }).click();
    const delRow = settings.locator('form.server-settings-cmd-row')
      .filter({ has: page.locator('.server-settings-cmd-label', { hasText: /^DEL$/ }) });
    await delRow.getByPlaceholder('memo number or ALL').fill('2');
    await delRow.getByRole('button', { name: 'Delete' }).click();
    await memoNet.waitForCommand(/^DEL 2$/);
    await expect(delRow.locator('xpath=..').getByText('Memo 2 has been deleted.')).toBeVisible();
  } finally {
    await memoNet.stop();
  }
});

test('DMs and mentions land in the Inbox and open their conversation', async ({ launchApp }) => {
  const nick = randomNick('ibx');
  const channel = randomChannel('ibx');
  const peer = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: randomNick('pal') });
  try {
    await peer.join(channel);
    const { page } = await launchApp();
    await guestOnErgo(page, nick);
    await joinChannel(page, channel);
    await peer.waitForJoin(channel, nick);

    const dm = `psst ${uid()}`;
    peer.privmsg(nick, dm);
    const mention = `hey ${nick}, look ${uid()}`;
    peer.privmsg(channel, mention);
    // The mention is in the channel on screen: listed, but already read.
    // The DM arrived while you were in the channel: unread, and a toast.
    await expect(inboxButton(page)).toHaveAccessibleName('Notifications, 1 unread');
    await expect(page.locator('.ntoast').filter({ hasText: dm })).toBeVisible();

    // Messages: the DM.
    let inbox = await openInbox(page);
    const messagesTab = inbox.getByRole('tab', { name: /^Messages/ });
    const mentionsTab = inbox.getByRole('tab', { name: /^Mentions/ });
    await expect(inbox.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
    await messagesTab.click();
    const dmRow = inbox.locator('li.notes-item').filter({ hasText: dm });
    await expect(dmRow.locator('.bds-row-meta')).toContainText('direct message');
    await expect(dmRow.locator('.bds-row-title')).toHaveText(peer.nick);

    // Mentions: the channel line, with its channel.
    await mentionsTab.click();
    const mRow = inbox.locator('li.notes-item').filter({ hasText: mention });
    await expect(mRow.locator('.bds-row-meta')).toContainText(channel);

    // Open the DM from the list → the 1:1 conversation.
    await messagesTab.click();
    const openDm = dmRow.locator('button.bds-row-main');
    await openDm.click();
    await expect(inbox).toBeHidden();
    await expect(page.getByPlaceholder(`Message @${peer.nick}`)).toBeVisible();
    await expect(messageList(page).getByText(dm)).toBeVisible();

    // Open the mention → back in the channel.
    inbox = await openInbox(page);
    await inbox.getByRole('tab', { name: /^Mentions/ }).click();
    const openMention = inbox.locator('li.notes-item').filter({ hasText: mention }).locator('button.bds-row-main');
    await openMention.click();
    await expect(composer(page, channel)).toBeVisible();
    // Both opened: read.
    await expect(inboxButton(page)).toHaveAccessibleName('Notifications');

    // Clear empties the active filter only.
    inbox = await openInbox(page);
    await inbox.getByRole('tab', { name: /^Mentions/ }).click();
    await inbox.getByRole('button', { name: 'Clear' }).click();
    await expect(inbox.getByText(/^No mentions/)).toBeVisible();
    await inbox.getByRole('tab', { name: /^Messages/ }).click();
    await expect(inbox.locator('li.notes-item').filter({ hasText: dm })).toBeVisible();
  } finally {
    await peer.quit();
  }
});
