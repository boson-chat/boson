// Server icons and banners for servers saved before the directory moved to
// /v1. Those sessions key the server by the legacy boson API id (a uuid);
// the /v1 directory's listings are `net_…` and only remember the uuid as
// `legacy_id`. The restored connection must still find its listing (by
// legacy id or address) for the rail icon and the sidebar banner — v0.48
// matched by id only and showed neither.
import { randomUUID } from 'node:crypto';
import {
  test, expect, IRC_PORT, STACK, uid, continueAsGuest, randomNick, seededHostname, directorySql, signInWithPassword,
} from './fixtures';
import { png, railTile } from './helpers/directory';

interface Listing { id: string; icon_url?: string | null; banner_url?: string | null }

async function call<T>(token: string, method: string, path: string, body?: BodyInit, type = 'application/json'): Promise<T> {
  const res = await fetch(`${STACK.directory.url}${path}`, {
    method, body, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': type } : {}) },
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

test('a server saved under its legacy id still shows its icon and banner', async ({ launchApp, createAccount }) => {
  // ---- a verified listing with an icon + banner, imported from the legacy API ----
  const ownerUser = await createAccount();
  const { accessToken } = await signInWithPassword(ownerUser.email, ownerUser.password);
  const hostname = seededHostname('media');
  const name = `Media ${uid(6)}`;
  const created = (await call<{ network: Listing }>(accessToken, 'POST', '/v1/networks', JSON.stringify({
    hostname, port: IRC_PORT, tls: false, name, languages: ['en'],
  }))).network;
  await call(accessToken, 'POST', `/v1/networks/${created.id}/verify`);
  await call(accessToken, 'PUT', `/v1/networks/${created.id}/icon`, new Uint8Array(png(64, 64, [200, 40, 40])), 'image/png');
  const listing = (await call<{ network: Listing }>(accessToken, 'PUT', `/v1/networks/${created.id}/banner`,
    new Uint8Array(png(300, 100, [40, 40, 200])), 'image/png')).network;
  expect(listing.icon_url).toMatch(new RegExp(`^${STACK.directory.url}/media/`));
  expect(listing.banner_url).toMatch(new RegExp(`^${STACK.directory.url}/media/`));
  const legacyId = randomUUID();
  directorySql(`UPDATE networks SET legacy_id = '${legacyId}' WHERE id = '${created.id}'`);

  // ---- a session saved by an older client: the server under its legacy id ----
  const first = await launchApp();
  await continueAsGuest(first.page, randomNick('med'));
  await first.page.evaluate(({ id, name, hostname, port }) => {
    localStorage.setItem('boson:session:v2', JSON.stringify({
      servers: [{ server: { id, name, hostname, port, tls: false }, channels: [], activeChannel: null }],
      activeServerId: id,
    }));
  }, { id: legacyId, name, hostname, port: IRC_PORT });
  await first.app.close();

  // ---- relaunch: restored under the legacy id, with the listing's images ----
  const { page } = await launchApp();
  await expect(page.locator('.sidebar-server-name')).toHaveText(name, { timeout: 30_000 });
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
  await expect(railTile(page, name).locator('img.server-item-icon')).toHaveAttribute('src', listing.icon_url!);
  const header = page.locator('.channel-sidebar-header');
  await expect(header).toHaveClass(/channel-sidebar-header-banner/);
  await expect(header).toHaveAttribute('style', new RegExp(escapeRe(listing.banner_url!)));

  // Kept under its saved id (saved channels, bouncer route and synced
  // secrets are keyed by it).
  const saved = await page.evaluate(() => localStorage.getItem('boson:session:v2'));
  expect((JSON.parse(saved!) as { servers: { server: { id: string } }[] }).servers.map((s) => s.server.id)).toEqual([legacyId]);
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
