import { test, expect, type Locator, type Page } from '@playwright/test';

// User settings and Server settings on the shared design system: no
// circles or pills. User settings: a grouped left menu on desktop; on phones
// a list of the sections (44px+ rows) that drills into each one, with a back
// arrow to the list.

async function roundThings(page: Page, root: string): Promise<string[]> {
  return page.locator(root).evaluate((el) => {
    const out: string[] = [];
    for (const n of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      const r = getComputedStyle(n).borderRadius;
      if (r.includes('%') || /(\d{2,})px/.test(r) && parseFloat(r) >= 9) out.push(`${n.className} ${r}`);
    }
    return out;
  });
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');

// A phone's list row: its name is the section's, then what it's set to.
const phoneRow = (dialog: Locator, label: string): Locator =>
  dialog.locator('.settings-phone-list nav').getByRole('button', { name: new RegExp(`^${esc(label)}(:|$)`) });

// Desktop: the menu's entry. Phone: back to the list if in a section, then its row.
async function openSection(dialog: Locator, phone: boolean, label: string): Promise<void> {
  if (!phone) { await dialog.getByRole('tab', { name: label, exact: true }).click(); return; }
  const back = dialog.getByRole('button', { name: 'Back to settings' });
  if (await back.count()) await back.click();
  await phoneRow(dialog, label).click();
  await expect(dialog.locator('.bds-page-head .bds-page-title')).toHaveText(label);
}

const SECTIONS = [
  ['Profile', 'Profile'], ['Account & security', 'Account & security'], ['Privacy', 'Privacy'],
  ['Appearance', 'Appearance'], ['Notifications', 'Notifications'], ['Chat & media', 'Chat & media'],
  ['Voice', 'Voice'], ['Directories', 'Directories'], ['Bouncer', 'Bouncer (ZNC / BNC)'], ['About', 'About'],
] as const;

for (const [name, w, h, plat] of [['desktop', 1440, 900, ''], ['iphone', 390, 844, '&platform=ios']] as const) {
  const phone = name !== 'desktop';

  test(`user settings on ${name}: no circles or pills; switch rows`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/shots.html?view=settings&section=notifications${plat}`);
    const dialog = page.getByRole('dialog');
    if (phone) await expect(dialog.locator('.bds-page-head .bds-page-title')).toHaveText('Notifications');
    else await expect(dialog.getByRole('tab', { name: /^Notifications/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator('.bds-switch-row')).toHaveCount(8);
    expect(await roundThings(page, '.user-settings')).toEqual([]);
    if (phone) {
      // The back arrow and the list's rows are touch targets.
      const back = dialog.getByRole('button', { name: 'Back to settings' });
      expect(await back.evaluate((e) => (e as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
      await back.click();
      const rows = dialog.locator('.settings-phone-row .bds-row-main');
      await expect(rows.first()).toBeVisible();
      // Layout height (the dialog may still be scaling in).
      const heights = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight));
      for (const hgt of heights) expect(hgt).toBeGreaterThanOrEqual(56);
      expect(await roundThings(page, '.user-settings')).toEqual([]);
    }
  });

  test(`user settings on ${name}: every section opens, with one look`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    // ?voice=connected: the harness has voice, so the Voice entry shows.
    await page.goto(`/shots.html?view=settings${phone ? '' : '&section=profile'}&friends=1&images=1&voice=connected${plat}`);
    const dialog = page.getByRole('dialog');
    const labels = SECTIONS.map(([l]) => l);
    if (phone) {
      // The list: grouped, each row with what it's set to.
      const titles = dialog.locator('.settings-phone-list nav .bds-row-title');
      await expect(titles).toHaveText(labels);
      await expect(dialog.locator('.settings-phone-heading')).toHaveText(['You', 'App', 'Connections', 'About']);
      await expect(phoneRow(dialog, 'Bouncer')).toContainText('Off');
      await expect(phoneRow(dialog, 'About')).toContainText(/^About\s*v\d+\.\d+\.\d+/);
      await expect(phoneRow(dialog, 'Appearance')).toContainText('theme');
      // Signed in: the profile card on top opens Profile.
      await dialog.getByRole('button', { name: /^Your profile: ada/ }).click();
      await expect(dialog.locator('.bds-page-head .bds-page-title')).toHaveText('Profile');
    } else {
      await expect(dialog.getByRole('tab')).toHaveText(labels);
      await expect(dialog.locator('.settings-menu-heading')).toHaveText(['You', 'App', 'Connections']);
    }
    for (const [tab, heading] of SECTIONS) {
      await openSection(dialog, phone, tab);
      await expect(dialog.locator('.user-settings-section-title')).toHaveText(heading);
      // Booleans are switch rows: no bare switch with a label beside it.
      await expect(dialog.locator('.user-settings-section .bds-toggle-label')).toHaveCount(0);
    }
    expect(await roundThings(page, '.user-settings')).toEqual([]);
  });

  test(`user settings on ${name}: deep links by old names, directory switches line up, bouncer fields follow the switch`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/shots.html?view=settings&section=content${plat}`);
    const dialog = page.getByRole('dialog');
    if (phone) await expect(dialog.locator('.bds-page-head .bds-page-title')).toHaveText('Chat & media');
    else await expect(dialog.getByRole('tab', { name: 'Chat & media' })).toHaveAttribute('aria-selected', 'true');
    await page.goto(`/shots.html?view=settings&section=identity${plat}`);
    if (phone) await expect(dialog.locator('.bds-page-head .bds-page-title')).toHaveText('Profile');
    else await expect(dialog.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');

    await openSection(dialog, phone, 'Directories');
    const switches = dialog.getByRole('list', { name: 'Your directories' }).locator('.bds-toggle');
    await expect(switches).toHaveCount(2);
    const rights = await switches.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
    expect(new Set(rights).size).toBe(1);

    await openSection(dialog, phone, 'Bouncer');
    await expect(dialog.getByPlaceholder('znc.example.com')).toHaveCount(0);
    await dialog.getByText('Use a bouncer', { exact: true }).click();
    await expect(dialog.getByPlaceholder('znc.example.com')).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Use TLS', exact: true })).toBeChecked();
  });

  test(`user settings on ${name}: before signing in, Appearance and About only`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/shots.html?view=settings&section=about&mode=signedout${plat}`);
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.user-settings-row').filter({ hasText: 'Platform' })).not.toContainText(/MacIntel|Win32|x86_64/);
    if (phone) {
      await dialog.getByRole('button', { name: 'Back to settings' }).click();
      await expect(dialog.locator('.settings-phone-list nav .bds-row-title')).toHaveText(['Appearance', 'About']);
      // No profile card, no search, no headings for two rows.
      await expect(dialog.locator('.user-settings-phone-profile')).toHaveCount(0);
      await expect(dialog.getByRole('searchbox')).toHaveCount(0);
      await expect(dialog.locator('.settings-phone-heading')).toHaveCount(0);
    } else {
      await expect(dialog.getByRole('tab')).toHaveText(['Appearance', 'About']);
      await expect(dialog.locator('.settings-menu-heading')).toHaveCount(0);
    }
  });

  test(`server settings on ${name}: page header, nav rows, no circles`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/shots.html?view=services${plat}`);
    await expect(page.locator('.bds-page-head')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close settings' })).toHaveCount(1);
    if (phone) await page.locator('.settings-phone-list nav').getByRole('button', { name: /^Log/ }).click();
    else await page.getByRole('tab', { name: /^Log/ }).click();
    await expect(page.getByText('No entries yet.')).toBeVisible();
    expect(await roundThings(page, 'section.server-settings')).toEqual([]);
  });

  test(`server settings on ${name}: grouped like User settings; owner sections only for the owner`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    const all = ['About', 'Appearance', 'Identity', 'Notifications', 'Bouncer', 'Actions', 'Edit', 'Operators', 'Software', 'Log', 'Advanced'];
    const groups = ['This server', 'You here', 'Owner', 'Technical'];
    const titles = phone ? page.locator('.settings-phone-list nav .bds-row-title') : page.getByRole('tab');
    const headings = page.locator(phone ? '.settings-phone-heading' : '.settings-menu-heading');
    await page.goto(`/shots.html?view=services&owner=1&nettheme=1${plat}`);
    await expect(titles).toHaveText(all);
    await expect(headings).toHaveText(groups);
    // Every section opens, with its heading.
    for (const label of all) {
      if (phone) {
        await page.locator('.settings-phone-list nav').getByRole('button', { name: new RegExp(`^${esc(label)}(:|$)`) }).click();
        await expect(page.locator('.bds-page-head .bds-page-title')).toHaveText(label);
        await expect(page.locator('.server-settings-section-title')).not.toHaveCount(0);
        await page.getByRole('button', { name: 'Back to settings' }).click();
      } else {
        await page.getByRole('tab', { name: label, exact: true }).click();
        await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.server-settings-section-title')).not.toHaveCount(0);
      }
    }
    // Not the owner: no Edit or Operators, no Owner heading.
    await page.goto(`/shots.html?view=services${plat}`);
    await expect(titles).toHaveText(['About', 'Identity', 'Notifications', 'Bouncer', 'Actions', 'Software', 'Log', 'Advanced']);
    await expect(headings).toHaveText(['This server', 'You here', 'Technical']);
  });
}

// Phones: the list → a section → back, search, and a deep link that opens
// straight into its section (and back goes to the list, not closed).
test.describe('user settings on a phone: drill-down', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('list → section → back to the list', async ({ page }) => {
    await page.goto('/shots.html?view=settings&platform=ios&friends=1');
    const dialog = page.getByRole('dialog');
    // Opens on the list: no section yet, no tabs strip.
    await expect(dialog.locator('.settings-phone-list')).toBeVisible();
    await expect(dialog.getByRole('tab')).toHaveCount(0);
    await expect(dialog.locator('.user-settings-section')).toHaveCount(0);
    await phoneRow(dialog, 'Notifications').click();
    await expect(dialog.locator('.bds-page-head .bds-page-title')).toHaveText('Notifications');
    await expect(dialog.getByText('In-app toasts', { exact: true })).toBeVisible();
    // The modal's own title and close stay.
    await expect(dialog.getByRole('heading', { name: 'User settings' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Back to settings' }).click();
    await expect(dialog.locator('.settings-phone-list')).toBeVisible();
    await expect(dialog.locator('.bds-page-head')).toHaveCount(0);
    // A change shows in the list's hint when you come back.
    await phoneRow(dialog, 'Chat & media').click();
    await dialog.getByText('Show link previews', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Back to settings' }).click();
    await expect(phoneRow(dialog, 'Chat & media')).toContainText('Link previews off');
  });

  test('search filters the sections by name, hint and the settings in them', async ({ page }) => {
    await page.goto('/shots.html?view=settings&platform=ios&friends=1');
    const dialog = page.getByRole('dialog');
    const search = dialog.getByRole('searchbox', { name: 'Search settings' });
    await search.fill('znc');
    await expect(dialog.locator('.settings-phone-list nav .bds-row-title')).toHaveText(['Bouncer']);
    await search.fill('recovery');
    await expect(dialog.locator('.settings-phone-list nav .bds-row-title')).toHaveText(['Account & security']);
    await search.fill('zzzz');
    await expect(dialog.getByText('No settings match “zzzz”.')).toBeVisible();
  });

  test('a deep link opens its section; back goes to the list', async ({ page }) => {
    await page.goto('/shots.html?view=settings&platform=ios&section=about');
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.bds-page-head .bds-page-title')).toHaveText('About');
    await expect(dialog.locator('.user-settings-row').filter({ hasText: 'Version' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Back to settings' }).click();
    await expect(dialog).toBeVisible();
    await expect(phoneRow(dialog, 'About')).toBeVisible();
  });
});

// Server settings on a phone: the same drill-down as User settings, and
// Advanced's command groups drill down too.
test.describe('server settings on a phone: drill-down', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const row = (page: Page, label: string): Locator =>
    page.locator('.settings-phone-list nav').getByRole('button', { name: new RegExp(`^${esc(label)}(:|$)`) });

  test('list → section → back, with hints, 56px rows and a 44px back', async ({ page }) => {
    await page.goto('/shots.html?view=services&owner=1&nettheme=1&platform=ios');
    // Opens on the list: no section, no tabs.
    await expect(page.locator('.settings-phone-list')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.locator('.server-settings-section')).toHaveCount(0);
    await expect(row(page, 'Identity')).toContainText('ada');
    await expect(row(page, 'Bouncer')).toContainText('Off');
    await expect(row(page, 'Actions')).toContainText('Connected');
    await expect(row(page, 'Software')).toContainText('ngircd-27');
    const heights = await page.locator('.settings-phone-row .bds-row-main').evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight));
    expect(heights.length).toBe(11);
    for (const hgt of heights) expect(hgt).toBeGreaterThanOrEqual(56);
    const side = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
    expect(side.sw).toBeLessThanOrEqual(side.cw);

    await row(page, 'Software').click();
    await expect(page.locator('.bds-page-head .bds-page-title')).toHaveText('Software');
    await expect(page.locator('.bds-page-head .bds-page-sub')).toHaveText('Nebula');
    const back = page.getByRole('button', { name: 'Back to settings' });
    expect(await back.evaluate((e) => (e as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
    // One header: the list's own close is gone while a section shows.
    await expect(page.getByRole('button', { name: 'Close settings' })).toHaveCount(0);
    await back.click();
    await expect(page.locator('.settings-phone-list')).toBeVisible();
    await expect(page.locator('.bds-page-head .bds-page-title')).toHaveText('Nebula');
    expect(await roundThings(page, 'section.server-settings')).toEqual([]);
  });

  test('a deep link opens its section; back goes to the list', async ({ page }) => {
    await page.goto('/shots.html?view=services&platform=ios&section=bouncer');
    await expect(page.locator('.bds-page-head .bds-page-title')).toHaveText('Bouncer');
    await expect(page.getByText('Route this server through the bouncer', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to settings' }).click();
    await expect(row(page, 'Bouncer')).toBeVisible();
    // An owner-only section without ownership: the list.
    await page.goto('/shots.html?view=services&platform=ios&section=edit');
    await expect(page.locator('.settings-phone-list')).toBeVisible();
    await expect(row(page, 'Edit')).toHaveCount(0);
  });

  test('Advanced: command groups as a list, each opening on its own', async ({ page }) => {
    await page.goto('/shots.html?view=services&platform=ios&section=advanced');
    const groups = page.getByRole('navigation', { name: 'Command groups' });
    await expect(groups.locator('.bds-row-title')).toHaveText(['NickServ', 'Account', 'Lookups', 'ChanServ', 'Modes', 'Server', 'Memos', 'Cloak']);
    await expect(page.locator('.bds-tabs')).toHaveCount(0);
    const heights = await groups.locator('.bds-row-main').evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight));
    for (const hgt of heights) expect(hgt).toBeGreaterThanOrEqual(56);
    await groups.getByRole('button', { name: /^ChanServ/ }).click();
    await expect(page.locator('.bds-page-head .bds-page-title')).toHaveText('ChanServ');
    await expect(page.getByText('RECOVER', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to Advanced' }).click();
    await expect(groups).toBeVisible();
    await page.getByRole('button', { name: 'Back to settings' }).click();
    await expect(page.locator('.settings-phone-list')).toBeVisible();
  });
});
