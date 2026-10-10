// How incoming messages render: markdown (bold / italic / strike / code /
// code blocks / spoilers), mentions + channel references, pasted tables,
// long lines, and links (clicking one hands it to the OS browser).
import { test, expect, randomChannel } from './fixtures';
import {
  connectGuest, connectPeer, messages, memberRow, joinViaUi,
} from './helpers/chat';
import type { IrcPeer } from './irc-peer';

test.describe('message rendering', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit()));
    peers = [];
  });

  test('markdown, spoilers, references, long lines and links', async ({ launchApp }) => {
    const channel = randomChannel('md');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick, openedExternally } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    const row = (text: string) => messages(page).locator('.message-row').filter({ hasText: text });

    peer.privmsg(channel, 'fmt1 **bold** *italic* _under_ ~~gone~~ `x = 1` done');
    const r1 = row('fmt1');
    await expect(r1.locator('strong.md-bold')).toHaveText('bold');
    await expect(r1.locator('em.md-italic')).toHaveText(['italic', 'under']);
    await expect(r1.locator('s.md-strike')).toHaveText('gone');
    await expect(r1.locator('code.md-inline-code')).toHaveText('x = 1');

    peer.privmsg(channel, 'fmt2 ```const answer = 42;``` after');
    await expect(row('fmt2').locator('pre.md-code-block')).toHaveText('const answer = 42;');

    // Spoiler: hidden until clicked (or keyboard-activated).
    peer.privmsg(channel, 'fmt3 the butler did it: ||it was the butler|| ok');
    const spoiler = row('fmt3').locator('.md-spoiler');
    await expect(spoiler).toHaveAttribute('aria-label', 'Spoiler, click to reveal');
    await expect(spoiler).not.toHaveClass(/md-spoiler-revealed/);
    await spoiler.click();
    await expect(spoiler).toHaveClass(/md-spoiler-revealed/);
    peer.privmsg(channel, 'fmt4 ||second secret||');
    const spoiler2 = row('fmt4').locator('.md-spoiler');
    await spoiler2.focus();
    await page.keyboard.press('Enter');
    await expect(spoiler2).toHaveClass(/md-spoiler-revealed/);

    // Member names and #channels are highlighted.
    peer.privmsg(channel, `fmt5 ask ${nick} about ${channel} and #elsewhere`);
    await expect(row('fmt5').locator('.chat-token-mention')).toHaveText(nick);
    await expect(row('fmt5').locator('.chat-token-channel')).toHaveText([channel, '#elsewhere']);
    await expect(row('fmt5')).toHaveClass(/message-row-mention/);

    // mIRC formatting codes from other clients don't leak into the text.
    peer.privmsg(channel, 'fmt9 \x02bold\x02 \x0304,01red\x03 \x1Ditalic\x1D \x1Funder\x1F\x0F end');
    await expect(row('fmt9').locator('.message-row-text-body')).toHaveText('fmt9 bold red italic under end');

    // NOTICEs render as notices.
    peer.send(`NOTICE ${channel} :fmt6 a channel notice`);
    await expect(row('fmt6')).toHaveClass(/message-row-notice/);

    // A long line wraps inside the message column (no horizontal overflow).
    const long = `fmt7 ${'lorem ipsum dolor sit amet '.repeat(14)}end`;
    peer.privmsg(channel, long);
    await expect(row('fmt7')).toContainText('end');
    const overflow = await messages(page).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // Links: rendered as anchors; a click goes to the OS browser (stubbed).
    // `.invalid` never resolves, so the auto-loading preview fails offline.
    const url = 'https://docs.example.invalid/guide?a=1&b=2';
    peer.privmsg(channel, `fmt8 read ${url} first`);
    const link = row('fmt8').locator('a.md-link');
    await expect(link).toHaveAttribute('href', url);
    await link.click();
    await expect.poll(openedExternally).toContain(url);
    // The website preview for it settles to "unavailable".
    await expect(row('fmt8').locator('.embed-linkcard-hint')).toHaveText('Preview unavailable — open in browser', { timeout: 20_000 });
  });

  test('pasted tables and preformatted blocks', async ({ launchApp }) => {
    const channel = randomChannel('tbl');
    const peer = await connectPeer();
    peers.push(peer);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, channel, nick);
    await peer.join(channel);
    await expect(memberRow(page, peer.nick)).toBeVisible();

    // A markdown pipe table, one line per PRIVMSG, folds into one <table>.
    const lines = ['| name | score |', '|------|-------|'];
    for (let i = 1; i <= 14; i++) lines.push(`| player${i} | ${i * 10} |`);
    for (const l of lines) peer.privmsg(channel, l);
    const block = messages(page).locator('.message-preblock');
    const table = block.locator('table.message-table');
    await expect(table.locator('th')).toHaveText(['name', 'score']);
    // Long tables are capped with a "show all" toggle.
    await expect(table.locator('tbody tr')).toHaveCount(12, { timeout: 20_000 });
    await block.getByRole('button', { name: '▸ Show all 14 rows' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(14);
    await expect(table.locator('tbody tr').last().locator('td')).toHaveText(['player14', '140']);
    await block.getByRole('button', { name: '▾ Show less' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(12);
    await expect(block.locator('.message-row-name')).toHaveText(peer.nick);

    // Box-drawing art that isn't a table stays an aligned <pre>.
    peer.privmsg(channel, 'and now some art');
    for (const l of ['┌──────┐', '│ boxy │', '└──────┘']) peer.privmsg(channel, l);
    await expect(messages(page).locator('pre.message-preblock-pre').last()).toContainText('│ boxy │');
  });
});
