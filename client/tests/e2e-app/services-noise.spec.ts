// Services, servers and bots don't get a conversation of their own unless
// the user writes to them. The server's stored history (a proxy plays a
// history-keeping server / bouncer here, see helpers/history-proxy) lists
// DMs with NickServ (the app's own services probe and IDENTIFY, stored),
// a server name, and a CTCP-scanning bot; none of them comes back as a
// conversation, while a real DM does. What the user types to NickServ still
// opens @NickServ, with its replies, and a password is shown masked.
import { test, expect, randomChannel } from './fixtures';
import { command, connectGuest, conversation, joinViaUi, messages, sidebar } from './helpers/chat';
import { startHistoryProxy, type HistoryProxy } from './helpers/history-proxy';

const MIN = 60_000;

test.describe('services noise', () => {
  let proxy: HistoryProxy | null = null;
  test.afterEach(async () => {
    await proxy?.close();
    proxy = null;
  });

  test("stored history with services, servers and bots brings back no conversation for them", async ({ launchApp }) => {
    test.setTimeout(180_000);
    proxy = await startHistoryProxy();
    const nick = `svc${Date.now() % 100000}`;
    const now = Date.now();
    proxy.setTargets(['NickServ', 'ChanServ', 'irc.history.test', 'py-ctcp', 'alice']);
    proxy.setHistory('NickServ', [
      { time: now - 10 * MIN, from: nick, to: 'NickServ', text: 'VERSION' },
      { time: now - 10 * MIN + 1, from: 'NickServ', to: nick, kind: 'NOTICE', text: 'Unknown command VERSION.' },
    ]);
    proxy.setHistory('ChanServ', [{ time: now - 10 * MIN, from: nick, to: 'ChanServ', text: 'VERSION' }]);
    proxy.setHistory('irc.history.test', [{ time: now - 9 * MIN, from: 'irc.history.test', to: nick, kind: 'NOTICE', text: '*** Your host is hidden' }]);
    proxy.setHistory('py-ctcp', [
      { time: now - 8 * MIN, from: 'py-ctcp', to: nick, text: '\x01VERSION\x01' },
      { time: now - 8 * MIN + 1, from: nick, to: 'py-ctcp', kind: 'NOTICE', text: '\x01VERSION Boson\x01' },
    ]);
    proxy.setHistory('alice', [{ time: now - 5 * MIN, from: 'alice', to: nick, text: 'hello from the history' }]);

    const { page } = await connectGuest(launchApp, { nick, port: proxy.port });
    // The real DM comes back…
    await expect(conversation(page, 'alice')).toBeVisible({ timeout: 30_000 });
    // …and was only asked for, with the other DMs, after the targets list.
    await expect.poll(() => proxy!.requests.filter((r) => r.includes('LATEST')).join('\n')).toContain('LATEST alice');
    const asked = proxy.requests.join('\n');
    expect(asked).not.toMatch(/LATEST (NickServ|ChanServ|irc\.history\.test)/i);
    // The bot's history was fetched (it's an ordinary nick) but is CTCP only.
    await page.waitForTimeout(1000);
    for (const name of ['NickServ', 'ChanServ', 'irc.history.test', 'py-ctcp']) {
      await expect(conversation(page, name), name).toHaveCount(0);
    }
    await page.screenshot({ path: test.info().outputPath('no-service-dms.png') });
  });

  test('/msg NickServ opens its conversation with the replies; IDENTIFY is masked', async ({ launchApp }) => {
    test.setTimeout(120_000);
    const { page, nick } = await connectGuest(launchApp);
    await joinViaUi(page, randomChannel('svc'), nick);
    // Connected: the services probe ran, and made no conversation.
    await page.waitForTimeout(3000);
    await expect(conversation(page, 'NickServ')).toHaveCount(0);

    await command(page, '/msg NickServ HELP');
    const row = conversation(page, 'NickServ');
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/channel-item-active/);
    const list = messages(page);
    await expect(list.getByText('HELP', { exact: true })).toBeVisible();
    // Ergo's NickServ answers HELP with its command list.
    await expect(list.getByText(/REGISTER/).first()).toBeVisible({ timeout: 15_000 });

    await command(page, '/msg NickServ IDENTIFY nobody wrong-password');
    await expect(list.getByText('IDENTIFY nobody ••••••')).toBeVisible();
    await expect(page.getByText('wrong-password')).toHaveCount(0);
    // Ergo refuses it, and says so here.
    await expect(list.getByText(/credentials|failed|could not/i).last()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('nickserv-conversation.png') });
    await expect(sidebar(page)).toBeVisible();
  });
});
