// Directory → Bouncer tab in depth: "Pull from bouncer" discovery against a
// real ZNC user carrying several networks (added through *controlpanel and
// dropped again afterwards), the search box over discovered + saved
// networks, Add / Add N matching / Add all new / Remove, discovery errors,
// and the per-network status column (Connect → Connecting… → Connected /
// Network offline + Connect network).
import {
  test, expect, uid, continueAsGuest, configureBouncerProfile, type ZncUser,
} from './fixtures';
import type { Page } from '@playwright/test';
import { addZncNetworks, dropExtraZncNetworks, listZncNetworks, zncOnIrc } from './helpers/znc-admin';

function bouncerTab(page: Page) {
  return page.getByRole('tab', { name: 'Bouncer' });
}

// The two lists the panel renders: what discovery found, and the saved
// bouncer networks (the last list on the panel).
function discoveredRows(page: Page) {
  return page.locator('.directory-bouncer-discovered .directory-bouncer-row');
}
function savedRows(page: Page) {
  return page.locator('.directory-bouncer > .directory-bouncer-list .directory-bouncer-row');
}
function savedRow(page: Page, name: string) {
  return savedRows(page).filter({ has: page.locator('.directory-bouncer-name', { hasText: new RegExp(`^${name}$`) }) });
}
function discoveredRow(page: Page, name: string) {
  return discoveredRows(page).filter({ has: page.locator('.directory-bouncer-name', { hasText: new RegExp(`^${name}$`) }) });
}

async function guestWithBouncer(page: Page, z: ZncUser, password = z.password): Promise<void> {
  await continueAsGuest(page, `bn${uid()}`);
  await configureBouncerProfile(page, { host: z.host, port: z.port, username: z.username, password, tls: false });
  await bouncerTab(page).click();
}

test.describe('bouncer networks panel', () => {
  test('without a bouncer profile the tab points at User Settings and offers no discovery', async ({ launchApp }) => {
    const { page } = await launchApp();
    await continueAsGuest(page, `bn${uid()}`);
    await bouncerTab(page).click();
    await expect(page.getByText('No bouncer enabled')).toBeVisible();
    await expect(page.getByText('User Settings → Bouncer')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pull from bouncer' })).toHaveCount(0);
    await expect(page.getByText('No bouncer networks yet — add one above.')).toBeVisible();
    // No list yet → no search box either.
    await expect(page.getByRole('searchbox', { name: 'Search networks' })).toHaveCount(0);
    // The add form needs at least one field.
    const add = page.getByRole('button', { name: 'Add network' });
    await expect(add).toBeDisabled();
    await page.getByPlaceholder('ZNC network, e.g. libera').fill('libera');
    await expect(add).toBeEnabled();
    await add.click();
    // Display name falls back to the network name.
    await expect(savedRow(page, 'libera')).toContainText('network: libera');
    await expect(page.getByRole('searchbox', { name: 'Search networks' })).toBeVisible();
  });

  test('Pull from bouncer lists the ZNC networks; search, Add N matching, Add all new, Remove', async ({ launchApp, zncUser }) => {
    const tag = uid(4);
    const extra = [`alpha${tag}`, `beta${tag}`, `gamma${tag}`];
    await dropExtraZncNetworks(zncUser);
    await addZncNetworks(zncUser, extra);
    try {
      const { page } = await launchApp();
      await guestWithBouncer(page, zncUser);
      await expect(page.getByText(`${zncUser.host}:${zncUser.port}`)).toBeVisible();

      const pull = page.getByRole('button', { name: 'Pull from bouncer' });
      await pull.click();
      // The probe is a real IRC session to ZNC: welcome, *status
      // ListNetworks, a short capture window.
      await expect(page.getByRole('button', { name: 'Querying your bouncer…' })).toBeDisabled();
      await expect(page.getByText('Found on your bouncer:', { exact: true })).toBeVisible({ timeout: 30_000 });
      const all = [zncUser.network, ...extra];
      await expect(discoveredRows(page)).toHaveCount(all.length);
      for (const n of all) await expect(discoveredRow(page, n).getByRole('button', { name: 'Add' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add all new' })).toBeVisible();

      // ---- search narrows the discovered list ----
      const search = page.getByRole('searchbox', { name: 'Search networks' });
      await search.fill(`ALPHA${tag}`); // case-insensitive
      await expect(page.getByText(`Found on your bouncer: 1 of ${all.length}`)).toBeVisible();
      await expect(discoveredRows(page)).toHaveCount(1);
      await search.fill(tag);
      await expect(page.getByText(`Found on your bouncer: 3 of ${all.length}`)).toBeVisible();
      // While searching, the bulk action only adds what's on screen.
      await page.getByRole('button', { name: 'Add 3 matching' }).click();
      for (const n of extra) {
        await expect(discoveredRow(page, n).getByText('Added', { exact: true })).toBeVisible();
        await expect(savedRow(page, n)).toContainText(`network: ${n}`);
      }
      await expect(page.getByRole('button', { name: /^Add \d+ matching$/ })).toHaveCount(0);

      // A search that matches nothing says so for both lists.
      await search.fill('zz-no-such-net');
      await expect(page.getByText('No networks match “zz-no-such-net”.')).toBeVisible();
      await expect(page.getByText('None of your networks match “zz-no-such-net”.')).toBeVisible();

      // Escape clears the search (and doesn't close anything else).
      await search.press('Escape');
      await expect(search).toHaveValue('');
      await expect(page.getByText('Found on your bouncer:', { exact: true })).toBeVisible();
      await expect(savedRows(page)).toHaveCount(3);

      // Only `ergo` is still new → "Add all new" adds just that one.
      await discoveredRow(page, zncUser.network).waitFor();
      await page.getByRole('button', { name: 'Add all new' }).click();
      await expect(savedRow(page, zncUser.network)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add all new' })).toHaveCount(0);
      await expect(savedRows(page)).toHaveCount(4);

      // ---- Remove: the network is offered again by discovery ----
      await savedRow(page, `beta${tag}`).getByRole('button', { name: 'Remove' }).click();
      await expect(savedRow(page, `beta${tag}`)).toHaveCount(0);
      await expect(discoveredRow(page, `beta${tag}`).getByRole('button', { name: 'Add' })).toBeVisible();
      // …and a single Add puts it back.
      await discoveredRow(page, `beta${tag}`).getByRole('button', { name: 'Add' }).click();
      await expect(savedRow(page, `beta${tag}`)).toBeVisible();

      // Saved bouncer networks persist in the saved session: still there
      // after leaving and re-opening the tab.
      await page.getByRole('tab', { name: 'Directory' }).click();
      await bouncerTab(page).click();
      await expect(savedRows(page)).toHaveCount(4);
      for (const s of [zncUser.network, ...extra]) {
        await expect(savedRow(page, s).getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
      }

      // Discovery is read-only on the bouncer side: the probe's ListNetworks
      // changed nothing.
      expect((await listZncNetworks(zncUser)).sort()).toEqual(all.slice().sort());
    } finally {
      await dropExtraZncNetworks(zncUser);
    }
  });

  test('discovery with a wrong bouncer password reports what the bouncer said', async ({ launchApp, zncUser }) => {
    const { page } = await launchApp();
    await guestWithBouncer(page, zncUser, `wrong-${uid()}`);
    await page.getByRole('button', { name: 'Pull from bouncer' }).click();
    await expect(page.getByText("Couldn't reach your bouncer")).toBeVisible({ timeout: 30_000 });
    // ZNC rejects the PASS (464 / "Invalid Password") and drops the link;
    // the panel says so instead of failing silently.
    await expect(page.getByText(/check your credentials|did not respond/)).toBeVisible();
    // The button is usable again for a retry.
    await expect(page.getByRole('button', { name: 'Pull from bouncer' })).toBeEnabled();
    await expect(page.getByText('Found on your bouncer:', { exact: true })).toHaveCount(0);
  });

  test('status column: Connect → Connected, Network offline + Connect network after a disconnect', async ({ launchApp, zncUser }) => {
    const name = `ZNC Status ${uid(4)}`;
    const { page } = await launchApp();
    await guestWithBouncer(page, zncUser);
    await page.getByPlaceholder('Display name').fill(name);
    await page.getByPlaceholder('ZNC network, e.g. libera').fill(zncUser.network);
    await page.getByRole('button', { name: 'Add network' }).click();
    await savedRow(page, name).getByRole('button', { name: 'Connect', exact: true }).click();

    // Connecting lands in chat; auto-connect takes ZNC onto the network.
    const dot = page.locator('.sidebar-status-dot');
    await expect(dot).toHaveAttribute('data-state', 'connected', { timeout: 45_000 });

    // Back in the server browser the row reads Connected.
    const browser = page.getByRole('dialog', { name: 'Connect to a server' });
    await page.getByRole('button', { name: 'Browse / switch servers' }).click();
    await browser.getByRole('tab', { name: 'Bouncer' }).click();
    const row = savedRow(page, name);
    await expect(row.getByText('Connected', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
    await browser.getByRole('button', { name: 'Close' }).click();
    await expect(browser).toBeHidden();

    // Take the network down from the server rail; the server browser row
    // then says the bouncer is attached but off the network.
    const tile = page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: new RegExp(`^${name}`) });
    await tile.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Disconnect network' }).click();
    await expect(dot).toHaveAttribute('data-state', 'upstream-offline', { timeout: 30_000 });
    await expect(tile).toHaveAccessibleName(`${name} (network offline)`);
    await page.getByRole('button', { name: 'Browse / switch servers' }).click();
    await browser.getByRole('tab', { name: 'Bouncer' }).click();
    await expect(row.getByText('Network offline', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Connect network', exact: true }).click();
    await expect(row.getByText('Connected', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(row.getByRole('button', { name: 'Connect network', exact: true })).toHaveCount(0);
    expect(await zncOnIrc(zncUser)).toBe(true);

    // Remove on a live network disconnects it and drops the row.
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
  });
});
