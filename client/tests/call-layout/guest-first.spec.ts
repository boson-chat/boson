import { test, expect, type Page } from '@playwright/test';

// Guest-first entry on a self-hosted web client (shots.html?view=guestfirst:
// IRCForever's web client over a scripted IRC server): a ready nick, "Join
// chat", and you're in #IRCForever with its conversation and members.

const SHOTS = process.env['SHOTS_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function fits(page: Page): Promise<void> {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBeLessThanOrEqual(width);
}

const nickBox = (page: Page) => page.getByRole('textbox', { name: 'Nickname' });
const guestNick = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('boson:guest:v1') ?? 'null')?.nick as string | undefined);

for (const [label, size] of [['desktop', { width: 1280, height: 820 }], ['phone', { width: 375, height: 780 }]] as const) {
  test(`entry → Join chat → in #IRCForever at ${label} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/shots.html?view=guestfirst');
    await expect(page.getByRole('heading', { name: 'IRCForever', level: 1 })).toBeVisible();
    const nick = await nickBox(page).inputValue();
    expect(nick).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
    await expect(page.getByText('#IRCForever', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await fits(page);
    await shot(page, `guestfirst-${label}-1-entry`);

    await page.getByRole('button', { name: 'Join chat' }).click();
    // In the channel: its conversation and its members.
    await expect(page.getByText('yep, guests land straight in here now. no signup needed')).toBeVisible();
    if (label === 'desktop') {
      await expect(page.getByRole('complementary').getByText('thelion').first()).toBeVisible();
      await expect(page.getByText('#help').first()).toBeVisible();
    }
    expect(await guestNick(page)).toBe(nick);
    const sent = await page.evaluate(() => (window as unknown as { __ircSent: Array<{ type: string; params: { channel?: string; nick?: string } }> }).__ircSent);
    expect(sent.find((c) => c.type === 'connect')?.params.nick).toBe(nick);
    expect(sent.filter((c) => c.type === 'join').map((c) => c.params.channel?.toLowerCase())).toEqual(['#help', '#ircforever']);
    await fits(page);
    await shot(page, `guestfirst-${label}-2-in-channel`);
  });
}

test('deep link: ?nick= ?channel= ?join=1 lands in that channel without the click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=guestfirst&nick=Wanderer&channel=help&join=1');
  await expect(page.getByText('ask away, someone will answer')).toBeVisible();
  expect(await guestNick(page)).toBe('Wanderer');
  // The link's parameters are dropped from the address bar.
  expect(new URL(page.url()).search).toBe('?view=guestfirst');
  await shot(page, 'guestfirst-desktop-3-deeplink');
});

test("a channel kept to roles isn't landed on", async ({ page }) => {
  await page.goto('/shots.html?view=guestfirst&channel=%23opers');
  await expect(page.getByText('#IRCForever', { exact: true })).toBeVisible();
});

test('returning visitor keeps the nick', async ({ page }) => {
  await page.goto('/shots.html?view=guestfirst');
  await nickBox(page).fill('Wanderer');
  await page.getByRole('button', { name: 'Join chat' }).click();
  await expect(page.getByText('morning all')).toBeVisible();
  // Back later: still in, as Wanderer.
  await page.goto('/shots.html?view=guestfirst');
  await expect(page.getByText('morning all')).toBeVisible();
  expect(await guestNick(page)).toBe('Wanderer');
  // Out of guest mode (signed out on this device): the entry keeps the nick.
  await page.evaluate(() => localStorage.removeItem('boson:guest:v1'));
  await page.goto('/shots.html?view=guestfirst');
  await expect(nickBox(page)).toHaveValue('Wanderer');
});

test('a made nick that is taken: a fresh friendly one, not Nick_', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('boson:guest:last-nick:v1', JSON.stringify({ nick: 'ZestyKiwi', auto: true })));
  await page.goto('/shots.html?view=guestfirst&taken=ZestyKiwi');
  await expect(nickBox(page)).toHaveValue('ZestyKiwi');
  await page.getByRole('button', { name: 'Join chat' }).click();
  await expect(page.getByText('morning all')).toBeVisible();
  await expect.poll(() => guestNick(page), { timeout: 10_000 }).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d\d$/);
  const sent = await page.evaluate(() => (window as unknown as { __ircSent: Array<{ type: string; params: { nick?: string } }> }).__ircSent);
  expect(sent.find((c) => c.type === 'nick')?.params.nick).toBe(await guestNick(page));
});

test('guest_first off: the sign-in screen as before', async ({ page }) => {
  await page.goto('/shots.html?view=guestfirst&gf=0');
  await expect(page.getByRole('textbox', { name: 'Username or email' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join chat' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue without an account' })).toBeVisible();
});

for (const [label, size] of [['desktop', { width: 1280, height: 820 }], ['phone', { width: 375, height: 780 }]] as const) {
  test(`in the chat: keep your nick, sign in with boson.chat first at ${label} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/shots.html?view=guestfirst&nick=Wanderer&join=1');
    await expect(page.getByText('morning all')).toBeVisible();
    if (label === 'phone') {
      // The channel list holds the network's account line.
      await page.getByRole('button', { name: /back|channels/i }).first().click();
    }
    await expect(page.getByTestId('guest-keep-hint')).toHaveText('Sign in to keep your nick and history.');
    await shot(page, `guestfirst-${label}-4-keep-hint`);
    await page.getByRole('button', { name: 'Sign in to IRCForever' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to IRCForever' });
    await expect(dialog.getByRole('button', { name: /Continue with boson\.chat/ })).toBeVisible();
    await expect(dialog.getByLabel('Username or email')).toBeVisible();
    await expect(dialog).not.toContainText('separate from');
    await expect(dialog).toContainText("IRCForever isn't taking new accounts. Use your boson.chat account, or sign in if you have an account here.");
    await shot(page, `guestfirst-${label}-5-signin-dialog`);
  });
}

test('in the chat with a boson.chat account here: "Continue as ada@boson.chat"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=guestfirst&homes=1&nick=Wanderer&join=1');
  await expect(page.getByText('morning all')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to IRCForever' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to IRCForever' });
  await expect(dialog.getByRole('button', { name: 'Continue as ada@boson.chat' })).toBeVisible();
  await shot(page, 'guestfirst-desktop-6-continue-as');
});

test('signing in from the chat upgrades the guest in place: same tab, channels rejoined', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=guestfirst&homes=1&nick=Wanderer&join=1');
  await expect(page.getByText('morning all')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to IRCForever' }).click();
  await page.getByRole('button', { name: 'Continue as ada@boson.chat' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Out of guest mode, on the same screen, back in both channels.
  await expect.poll(() => guestNick(page)).toBeUndefined();
  await expect(page.locator('.title-bar-user')).toContainText('ada');
  await expect(page.getByText('morning all')).toBeVisible();
  const sent = await page.evaluate(() => (window as unknown as { __ircSent: Array<{ type: string; params: { channel?: string; nick?: string } }> }).__ircSent);
  const reconnect = sent.map((c) => c.type).lastIndexOf('connect');
  expect(sent[reconnect]?.params.nick).toBe('ada-bosonchat');
  expect(sent.slice(reconnect).filter((c) => c.type === 'join').map((c) => c.params.channel?.toLowerCase())).toEqual(['#help', '#ircforever']);
  await shot(page, 'guestfirst-desktop-7-upgraded');
});

// A network with no RoleServ (ngIRCd behind the evrd bridge, like
// ircforever): the app joins its auth config's auto-join channels itself.
test.describe('auto-join channels on a bridged network', () => {
  const joins = (page: Page) => page.evaluate(() => ((window as unknown as { __ircSent?: Array<{ type: string; params: { channel?: string } }> }).__ircSent ?? [])
    .filter((c) => c.type === 'join').map((c) => c.params.channel?.toLowerCase()));

  test('a new account (federated, as after SSO) lands in them', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto('/shots.html?view=guestfirst&gf=0&homes=1');
    await page.getByRole('button', { name: 'Continue as ada@boson.chat' }).click();
    await expect(page.getByText('morning all')).toBeVisible({ timeout: 20_000 });
    expect(await joins(page)).toEqual(['#ircforever', '#help']);
    await shot(page, 'autojoin-desktop-account');
  });

  test('a guest is joined once; a part stays parted after a reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto('/shots.html?view=guestfirst&gf=0');
    await page.getByRole('button', { name: 'Continue without an account' }).click();
    await page.getByRole('textbox', { name: 'Display name' }).fill('Wanderer');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Continue as guest' }).click();
    await expect(page.getByText('morning all')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => joins(page), { timeout: 10_000 }).toEqual(['#ircforever', '#help']);

    // Leave #help.
    const box = page.locator('textarea.chat-textarea');
    await box.click();
    await box.fill('/part #help');
    if (await page.locator('.chat-input-bar [role="listbox"]').count() > 0) await box.press('Escape');
    await box.press('Enter');
    await expect.poll(() => page.evaluate(() => ((window as unknown as { __ircSent: Array<{ type: string; params: { line?: string; channel?: string } }> }).__ircSent)
      .some((c) => c.type === 'part' || /^PART #help/i.test(c.params.line ?? '')))).toBe(true);

    // Back later: #ircforever (saved) only; #help isn't joined again.
    // (once the part is saved)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('boson:session:v2') ?? '')).not.toContain('#help');
    await page.reload();
    await expect(page.getByText('morning all')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(4000);
    expect(await joins(page)).toEqual(['#ircforever']);
  });
});
