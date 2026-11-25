// Sign-out leaves nothing of one person for the next on the same device:
// A signs in, connects, talks, saves a bouncer profile, signs out; B signs
// in on the same app profile and finds none of A's connections, servers,
// credentials, history or keys — while A's account keeps its synced copies.
import type { Page } from '@playwright/test';
import { test, expect, loginAs, randomChannel, secureStoreOnDisk, uid, configureBouncerProfile, field, continueAsGuest, confirmLeaveGuest } from './fixtures';
import { addServerAndConnect, connectPeer, joinViaUi, memberRow, messages, say, waitCmd } from './helpers/chat';
import type { IrcPeer } from './irc-peer';

// Every localStorage key (the page's origin).
const localKeys = (page: Page): Promise<string[]> => page.evaluate(() => {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)!);
  return out.sort();
});

// Rows of the local message history (IndexedDB) whose key starts with prefix.
const historyRows = (page: Page, prefix: string): Promise<number> => page.evaluate((p) => new Promise<number>((resolve) => {
  const r = indexedDB.open('boson-chat-history');
  r.onerror = () => resolve(0);
  r.onsuccess = () => {
    const db = r.result;
    const names = Array.from(db.objectStoreNames);
    if (names.length === 0) { db.close(); resolve(0); return; }
    let n = 0;
    const tx = db.transaction(names, 'readonly');
    for (const name of names) {
      const c = tx.objectStore(name).openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return;
        if (String(cur.key).startsWith(p) || JSON.stringify(cur.value).includes(p)) n++;
        cur.continue();
      };
    }
    tx.oncomplete = () => { db.close(); resolve(n); };
    tx.onerror = () => { db.close(); resolve(n); };
  };
}), prefix);

async function signOutFromSettings(page: Page, button = 'Sign out'): Promise<void> {
  await page.getByRole('button', { name: 'User settings' }).click();
  const settings = page.getByRole('dialog', { name: 'User settings' });
  await settings.getByRole('tab', { name: /^Account/ }).click();
  await settings.getByRole('button', { name: button }).click();
  // Leaving guest mode asks first: it erases the guest's data.
  if (button === 'Switch to an account') await confirmLeaveGuest(page);
  await expect(page.locator('.login-screen')).toBeVisible({ timeout: 30_000 });
}

// The ACCOUNT keys of modules/signout/storage-keys.ts (what must be gone).
const PERSONAL_LOCAL = /^(boson:session:|boson:local-servers:|boson:directories:|boson:autojoin-done:|boson:guest:|boson:notifications:channels:|boson\.netauth\.|boson\.login\.|boson\.memos\.|boson:notify-feed:|boson\.voice\.guestId:|boson\.services-creds\.|boson:recovery-pending:)/;
const PERSONAL_SECURE = /^(boson\.auth\.session|boson\.identity\.|boson\.netauth\.session:|boson\.services-creds\.v1|boson\.bouncer\.v1|boson\.nickserv-sync\.meta|boson\.bouncer-sync\.meta)/;

test.describe('sign-out cleanup', () => {
  let peers: IrcPeer[] = [];
  test.afterEach(async () => {
    await Promise.all(peers.map((p) => p.quit().catch(() => {})));
    peers = [];
  });

  test("signing out disconnects and forgets A's data; B on the same device starts clean", async ({ launchApp, profile, createAccount, backendApi }) => {
    test.setTimeout(240_000);
    const [a, b] = await Promise.all([createAccount({ handle: true }), createAccount({ handle: true })]);
    const channel = randomChannel('signout');
    const serverName = `Signout Ergo ${uid(4)}`;
    const secretLine = `only for alice ${uid(8)}`;
    const bouncer = { host: `znc-${uid()}.example.test`, port: 7000, username: `u${uid()}`, password: `pw-${uid(10)}` };
    const peer = await connectPeer();
    peers.push(peer);
    await peer.join(channel);

    // ---- A: connect, talk, save a bouncer profile ----
    const { page } = await launchApp();
    expect(await loginAs(page, a)).toBe('directory');
    await addServerAndConnect(page, serverName);
    await joinViaUi(page, channel, a.handle!);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    peer.privmsg(channel, secretLine);
    await expect(messages(page).getByText(secretLine)).toBeVisible();
    await say(page, 'alice was here');
    await waitCmd(peer, 'PRIVMSG', a.handle!, (l) => l.params[1] === 'alice was here');
    await configureBouncerProfile(page, bouncer);
    const apiA = await backendApi(a);
    await expect.poll(async () => JSON.stringify((await apiA.get<{ payload: unknown }>('/me/session')).payload ?? null), { timeout: 15_000 })
      .toContain(channel);
    await expect.poll(async () => (await apiA.get<{ bouncer: unknown }>('/me/bouncer')).bouncer, { timeout: 15_000 }).not.toBeNull();
    expect(await historyRows(page, a.id)).toBeGreaterThan(0);

    // ---- A signs out ----
    const mark = peer.mark();
    await signOutFromSettings(page);
    // A's IRC connection really ends (not left for the next sign-in to adopt).
    await peer.waitFor((l) => l.command === 'QUIT' && l.prefix.split('!')[0] === a.handle, 20_000, `QUIT from ${a.handle}`, mark);

    // Nothing personal left on the device.
    await expect.poll(async () => (await localKeys(page)).filter((k) => PERSONAL_LOCAL.test(k)), { timeout: 15_000 }).toEqual([]);
    await expect.poll(async () => Object.keys(await secureStoreOnDisk(page, profile.userData)).filter((k) => PERSONAL_SECURE.test(k)), { timeout: 15_000 })
      .toEqual([]);
    expect(await historyRows(page, a.id)).toBe(0);

    // A's account keeps its synced copies: sign-out isn't a delete.
    expect(JSON.stringify((await apiA.get<{ payload: unknown }>('/me/session')).payload ?? null)).toContain(channel);
    expect((await apiA.get<{ bouncer: unknown }>('/me/bouncer')).bouncer).not.toBeNull();

    // ---- B signs in on the same device ----
    expect(await loginAs(page, b)).toBe('directory');
    // No server of A's is listed, restored or connected.
    await page.waitForTimeout(3_000);
    await expect(page.getByRole('navigation', { name: 'Servers' })).toBeHidden();
    await expect(page.getByText(serverName)).toHaveCount(0);
    const names = await peer.names(channel);
    expect(names).not.toContain(a.handle);
    expect(names).not.toContain(b.handle);
    // A's bouncer profile isn't B's, here or in B's account.
    await page.getByRole('button', { name: 'User settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'User settings' });
    await dialog.getByRole('tab', { name: /^Bouncer/ }).click();
    // No bouncer: off, so its connection fields are hidden; switched on, they're empty.
    const useBouncer = dialog.getByRole('checkbox', { name: 'Use a bouncer', exact: true });
    await expect(useBouncer).not.toBeChecked();
    await expect(field(dialog, 'Host')).toHaveCount(0);
    await dialog.getByText('Use a bouncer', { exact: true }).click();
    await expect(field(dialog, 'Host')).toHaveValue('');
    await expect(field(dialog, 'Password')).toHaveValue('');
    await dialog.getByRole('button', { name: 'Close' }).click();
    const apiB = await backendApi(b);
    await page.waitForTimeout(2_000);
    expect((await apiB.get<{ bouncer: unknown }>('/me/bouncer')).bouncer).toBeNull();
    expect(JSON.stringify((await apiB.get<{ payload: unknown }>('/me/session')).payload ?? null)).not.toContain(channel);
    // None of A's keys came back for B.
    const secure = Object.keys(await secureStoreOnDisk(page, profile.userData));
    expect(secure.filter((k) => k.includes(a.id))).toEqual([]);
    expect((await localKeys(page)).filter((k) => k.includes(a.id))).toEqual([]);
    expect(await historyRows(page, a.id)).toBe(0);
  });

  test('leaving guest mode is a full sign-out: the guest\'s servers and connections never reach the account', async ({ launchApp, profile, createAccount }) => {
    test.setTimeout(180_000);
    const b = await createAccount({ handle: true });
    const channel = randomChannel('guestout');
    const serverName = `Guest Ergo ${uid(4)}`;
    const nick = `g${uid(6)}`;
    const peer = await connectPeer();
    peers.push(peer);
    await peer.join(channel);

    // ---- a guest connects and talks ----
    const { page } = await launchApp();
    await continueAsGuest(page, nick);
    await addServerAndConnect(page, serverName);
    await joinViaUi(page, channel, nick);
    await expect(memberRow(page, peer.nick)).toBeVisible();
    await say(page, 'guest was here');
    await waitCmd(peer, 'PRIVMSG', nick, (l) => l.params[1] === 'guest was here');

    // ---- "Switch to an account" ----
    const mark = peer.mark();
    await signOutFromSettings(page, 'Switch to an account');
    await peer.waitFor((l) => l.command === 'QUIT' && l.prefix.split('!')[0] === nick, 20_000, `QUIT from ${nick}`, mark);
    await expect.poll(async () => (await localKeys(page)).filter((k) => PERSONAL_LOCAL.test(k)), { timeout: 15_000 }).toEqual([]);
    await expect.poll(async () => Object.keys(await secureStoreOnDisk(page, profile.userData)).filter((k) => PERSONAL_SECURE.test(k)), { timeout: 15_000 })
      .toEqual([]);

    // ---- the account signs in: none of the guest's servers came along ----
    expect(await loginAs(page, b)).toBe('directory');
    await page.waitForTimeout(3_000);
    await expect(page.getByRole('navigation', { name: 'Servers' })).toBeHidden();
    await expect(page.getByText(serverName)).toHaveCount(0);
    const names = await peer.names(channel);
    expect(names).not.toContain(nick);
    expect(names).not.toContain(b.handle);
  });
});
