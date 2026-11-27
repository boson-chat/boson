// Browser push (docs/push.md §3, web client): signed in to a Boson network
// whose Ergo offers draft/webpush (infra/e2e/ergo2.yaml), the web app finds
// the cap and VAPID=, registers a service worker for the server and sends
// WEBPUSH REGISTER with the subscription's keys; the worker shows the IRC
// line a push carries as "<nick> · <server>" and takes it down again on a
// read marker.
//
// What it can't do here: get a subscription from a real push service
// (headless Chromium has none), or have Ergo deliver to a local receiver
// (Ergo refuses internal addresses). So the subscription is the test's own
// (real P-256 keys, an unreachable endpoint): Ergo decodes the keys, tries
// its test push, and answers FAIL, which the settings row shows. The push
// itself reaches the real worker through Chromium's DevTools protocol
// (ServiceWorker.deliverPushMessage: the decrypted payload, as the browser
// would hand it over).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  test, expect, STACK, addServerManually, continueAsGuest, randomEmail, randomPassword, randomUsername, serverCard, uid, IS_WEB,
} from './fixtures';

const NET = STACK.selfhost;

function networkJson(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boson-net-'));
  const file = join(dir, 'boson.json');
  writeFileSync(file, JSON.stringify({ version: 1, irc: { host: NET.irc.host, port: NET.irc.port, tls: false }, auth: { url: NET.auth.url } }));
  return file;
}

function subscription(): { endpoint: string; p256dh: string; auth: string } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { endpoint: `https://push.invalid/e2e/${uid()}`, p256dh: raw.toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

async function registerOnNetwork(): Promise<{ username: string; password: string }> {
  const username = randomUsername('push');
  const password = randomPassword();
  const res = await fetch(`${NET.auth.url}/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: randomEmail('push'), password }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return { username, password };
}

// The push worker's registration id, for DevTools.
async function workerRegistration(page: Page): Promise<{ id: string; scope: string; send: (data: string) => Promise<void> }> {
  const cdp = await page.context().newCDPSession(page);
  const regs: Array<{ registrationId: string; scopeURL: string; isDeleted: boolean }> = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: typeof regs }) => { regs.push(...e.registrations); });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => regs.find((r) => r.scopeURL.includes('/push/') && !r.isDeleted)?.registrationId ?? '', { timeout: 15_000 }).not.toBe('');
  const reg = regs.find((r) => r.scopeURL.includes('/push/') && !r.isDeleted)!;
  const origin = new URL(reg.scopeURL).origin;
  return {
    id: reg.registrationId,
    scope: reg.scopeURL,
    send: async (data) => { await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: reg.registrationId, data }); },
  };
}

async function shownNotifications(page: Page, scope: string): Promise<Array<{ title: string; body: string; tag: string }>> {
  return page.evaluate(async (s) => {
    const reg = await navigator.serviceWorker.getRegistration(s);
    if (!reg) return [];
    return (await reg.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag }));
  }, scope);
}

test.describe('push notifications (web)', () => {
  test.skip(!IS_WEB, 'browser push is the web build’s; the phone apps’ is native');
  test.skip(({ browserName }) => browserName !== 'chromium', 'DevTools push delivery is Chromium’s');

  test('registers with the server and shows what a push carries', async ({ launchApp }) => {
    test.setTimeout(180_000);
    const user = await registerOnNetwork();
    const sub = subscription();
    const name = `Push ${uid()}`;
    const { page } = await launchApp({ env: { BOSON_NETWORK_JSON: networkJson(), BOSON_E2E_PUSH_SUBSCRIPTION: JSON.stringify(sub) } });
    await continueAsGuest(page, `g${uid()}`);

    await addServerManually(page, { hostname: NET.irc.host, port: NET.irc.port, name, tls: false });
    await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog', { name: `Sign in to ${name}` });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('tab', { name: 'Sign in' }).click().catch(() => {});
    await dialog.getByPlaceholder('username or email', { exact: true }).fill(user.username);
    await dialog.getByPlaceholder('password', { exact: true }).fill(user.password);
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });

    // Settings → Notifications: the server's row. Ergo took the keys (else
    // "Invalid subscription keys") and failed only its test push to the
    // test's unreachable endpoint.
    await page.getByRole('button', { name: 'User settings' }).click();
    const settings = page.getByRole('dialog', { name: 'User settings' });
    await settings.getByRole('tab', { name: /Notifications/ }).click();
    await expect(settings.getByText('When Boson is closed')).toBeVisible({ timeout: 20_000 });
    await expect(settings.locator('.bds-switch-row', { hasText: 'Test push message failed to send' })).toBeVisible({ timeout: 30_000 });
    if (process.env['PUSH_SHOTS_DIR']) {
      await settings.getByText('When Boson is closed').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env['PUSH_SHOTS_DIR'], 'settings-push.png') });
    }

    // The worker for this server is registered. While this tab has the
    // server connected, a push is left to the page's own notifications.
    const w = await workerRegistration(page);
    const dm = '@time=2026-11-27T10:00:00.000Z;msgid=m1 :alice!a@example PRIVMSG me :hello from push';
    await w.send(dm);
    await page.waitForTimeout(1_000);
    expect(await shownNotifications(page, w.scope)).toEqual([]);
    // Once the tab's heartbeat is stale (a frozen tab, a closed one), the
    // worker shows it.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open('boson-push', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise<void>((res) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const all = store.getAllKeys();
        all.onsuccess = () => { for (const k of all.result) if (String(k).startsWith('live:')) store.put(0, k); };
        tx.oncomplete = () => res();
      });
      db.close();
    });
    await w.send(dm);
    await expect.poll(() => shownNotifications(page, w.scope), { timeout: 10_000 })
      .toEqual([{ title: expect.stringMatching(/^alice · /), body: 'hello from push', tag: expect.stringMatching(/:alice$/) }]);

    // The test push shows nothing; a read marker takes the DM down.
    await w.send('PING webpush');
    await w.send('@time=2026-11-27T10:00:05.000Z :ergo2.e2e MARKREAD alice timestamp=2026-11-27T10:00:01.000Z');
    await expect.poll(() => shownNotifications(page, w.scope), { timeout: 10_000 }).toEqual([]);
  });
});
