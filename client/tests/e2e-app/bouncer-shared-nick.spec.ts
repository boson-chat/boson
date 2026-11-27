// Two devices, one bouncer connection: the nick one device picks is the
// shared connection's nick, and a second device attaching fresh (no nick
// saved for the server) takes it rather than renaming the connection to its
// own default.
import {
  test, expect, IRC_HOST, IRC_PORT, uid,
  continueAsGuest, configureBouncerProfile,
} from './fixtures';
import { IrcPeer } from './irc-peer';
import { zncOnIrc, zncUpstream } from './helpers/znc-admin';

test('device A picks the nick; device B attaching fresh sends no NICK and adopts it', async ({ launchApp, zncUser }) => {
  const channel = `#e2e-shn-${uid(8)}`;
  const picked = `pk${uid(8)}`;
  const displayName = `ZNC Shared ${uid(4)}`;
  const watcher = await IrcPeer.connect({ host: IRC_HOST, port: IRC_PORT, nick: `w${uid()}` });
  // Device A: another client of the same ZNC user.
  const deviceA = await IrcPeer.connect({
    host: zncUser.host, port: zncUser.port, nick: `devA${uid(6)}`,
    pass: `${zncUser.username}/${zncUser.network}:${zncUser.password}`,
  });
  try {
    await watcher.join(channel);
    await zncUpstream(zncUser, 'connect');
    await expect.poll(() => zncOnIrc(zncUser), { timeout: 30_000 }).toBe(true);
    deviceA.send(`JOIN ${channel}`);
    await watcher.waitFor((l) => l.command === 'JOIN' && (l.params[0] ?? '').toLowerCase() === channel.toLowerCase(), 30_000, 'bouncer join');
    // Device A changes the shared connection's nick.
    const nickMark = watcher.mark();
    deviceA.send(`NICK ${picked}`);
    await watcher.waitFor((l) => l.command === 'NICK' && l.params[0] === picked, 15_000, 'NICK to the picked nick', nickMark);

    // Device B: the app, signing in for the first time (guest nick, nothing
    // saved for this server).
    const { page } = await launchApp();
    await continueAsGuest(page, `devb${uid()}`);
    await configureBouncerProfile(page, {
      host: zncUser.host, port: zncUser.port, username: zncUser.username, password: zncUser.password, tls: false,
    });
    await page.getByRole('tab', { name: 'Bouncer' }).click();
    await page.getByPlaceholder('Display name').fill(displayName);
    await page.getByPlaceholder('ZNC network, e.g. libera').fill(zncUser.network);
    await page.getByRole('button', { name: 'Add network' }).click();
    const row = page.locator('.directory-bouncer-row').filter({ hasText: displayName });
    const attachMark = watcher.mark();
    await row.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });
    await expect(page.locator('.chat-nick-chip')).toHaveText(picked, { timeout: 15_000 });
    // Past the app's first nick-reclaim retry (5 s): still nobody renamed
    // the shared connection.
    await page.waitForTimeout(7_000);
    await expect(page.locator('.chat-nick-chip')).toHaveText(picked);
    const renames = watcher.lines.slice(attachMark).filter((l) => l.command === 'NICK');
    expect(renames).toEqual([]);
  } finally {
    await deviceA.quit().catch(() => {});
    await watcher.quit().catch(() => {});
  }
});
