import { test, expect, type Page } from '@playwright/test';

// The sign-in screen of a network with a theme wears its colours (Sign in
// button, active tab, inputs), as the admin's "Sign-in screen" preview
// shows; an unthemed network keeps Boson's. A network that takes no new
// accounts hides Signup and offers "Continue with boson.chat" when it
// accepts accounts from other Boson servers.

const SHOTS = process.env['SHOTS_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
const accent = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());

test('a themed network: its accent on the sign-in screen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=signin&theme=1');
  const signIn = page.getByRole('button', { name: 'Sign in' });
  await expect(signIn).toBeVisible();
  expect(await accent(page)).toBe('#70d199');
  // (Colours ease in.)
  await expect.poll(() => bg(page, '.login-actions .bds-btn-primary')).toBe('rgb(112, 209, 153)');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(11, 20, 16)');
  await shot(page, 'signin-themed-dark');
});

test('a themed network in light mode: its light variant', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=signin&theme=1&light=1');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await accent(page)).toBe('#1f8a52');
  await shot(page, 'signin-themed-light');
});

test("an unthemed network: Boson's default look", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=signin');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await accent(page)).not.toBe('#70d199');
  await expect.poll(() => bg(page, '.login-actions .bds-btn-primary')).not.toBe('rgb(112, 209, 153)');
  await shot(page, 'signin-unthemed');
});

for (const [label, size] of [['desktop', { width: 1280, height: 820 }], ['phone', { width: 375, height: 780 }]] as const) {
  test(`closed registration on a self-hosted network at ${label} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/shots.html?view=signin&theme=1&selfhosted=1&registration=closed');
    const cta = page.getByRole('button', { name: /Continue with boson\.chat/ });
    await expect(cta).toBeVisible();
    await expect(page.getByText("IRCForever isn't taking new accounts. Use your boson.chat account, or continue as a guest.")).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Signup' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue without an account' })).toBeVisible();
    // Above the network's own sign-in, tappable, nothing sideways.
    const c = (await cta.boundingBox())!;
    const field = (await page.getByPlaceholder('username or email').boundingBox())!;
    expect(c.y + c.height).toBeLessThan(field.y);
    expect(c.height).toBeGreaterThanOrEqual(44);
    const d = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
    expect(d.sw).toBeLessThanOrEqual(d.cw);
    await shot(page, `signin-closed-${label}`);

    // It signs in at boson.chat first.
    await cta.click();
    await expect(page.getByText(/Then you'll come back to IRCForever/)).toBeVisible();
    await shot(page, `signin-closed-bosonchat-${label}`);
  });
}

test('closed registration with a boson.chat account signed in here: "Continue as"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=signin&theme=1&selfhosted=1&registration=closed&homes=1');
  await expect(page.getByRole('button', { name: 'Continue as ada@boson.chat' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue with boson\.chat/ })).toHaveCount(0);
  await shot(page, 'signin-closed-continue-as');
});

test('invite-only registration: the invite code first', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/shots.html?view=signin&theme=1&registration=invite');
  await page.getByRole('tab', { name: 'Signup' }).click();
  const first = page.locator('form input').first();
  await expect(first).toHaveAttribute('placeholder', 'invite code');
  await expect(first).toHaveAttribute('required', '');
  await page.waitForTimeout(400); // the tab underline slides over
  await shot(page, 'signin-invite');
});
