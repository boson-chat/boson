import { test, expect, type Page } from '@playwright/test';

// "Sign in to <network>" on a server that takes accounts from other Boson
// servers (federation spec v1 §5): one "Continue as …" per home account,
// above the network's own Sign in / Create account, readable and tappable
// at desktop and phone widths; a refusal explains itself and offers
// "Create an account here instead".

const SHOTS = process.env['SHOTS_DIR'];

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function noSideways(page: Page): Promise<void> {
  const d = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, cw: document.scrollingElement!.clientWidth }));
  expect(d.sw, 'page scrolls sideways').toBeLessThanOrEqual(d.cw);
}

for (const [label, size] of [['desktop', { width: 1280, height: 820 }], ['phone', { width: 375, height: 780 }]] as const) {
  test(`continue as … at ${label} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/shots.html?view=netsignin');
    const dialog = page.getByRole('dialog', { name: 'Sign in to Hexbay' });
    const ada = dialog.getByRole('button', { name: 'Continue as ada@boson.chat' });
    const second = dialog.getByRole('button', { name: 'Continue as ada_l@fediverse.party' });
    await expect(ada).toBeVisible();
    await expect(second).toBeVisible();

    // Above the network's own sign-in.
    const tabs = dialog.getByRole('tab', { name: 'Sign in' });
    const a = (await ada.boundingBox())!;
    const b = (await second.boundingBox())!;
    const t = (await tabs.boundingBox())!;
    expect(a.y + a.height).toBeLessThanOrEqual(b.y);
    expect(b.y + b.height).toBeLessThan(t.y);
    // Big enough to tap, the full width of the form, nothing cut off.
    expect(a.height).toBeGreaterThanOrEqual(44);
    const form = (await dialog.locator('.netauth-form').boundingBox())!;
    expect(Math.abs(a.width - form.width)).toBeLessThanOrEqual(2);
    const title = ada.locator('.netauth-fed-title');
    const fits = await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits).toBe(true);
    await noSideways(page);
    await shot(page, `federated-signin-${label}`);

    // Tapping one shows it working, the others wait.
    await ada.click();
    await expect(ada).toHaveAttribute('aria-busy', 'true');
    await expect(second).toBeDisabled();
    await expect(dialog.getByText('Asking boson.chat to vouch for you…')).toBeVisible();
  });

  test(`a refusal explains itself at ${label} width`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/shots.html?view=netsignin&fail=domain_not_trusted');
    const dialog = page.getByRole('dialog', { name: 'Sign in to Hexbay' });
    await dialog.getByRole('button', { name: 'Continue as ada@boson.chat' }).click();
    await expect(dialog.getByRole('alert')).toContainText('This server only accepts accounts from verified Boson servers');
    const create = dialog.getByRole('button', { name: 'Create an account here instead' });
    await expect(create).toBeVisible();
    await noSideways(page);
    await shot(page, `federated-signin-error-${label}`);
    await create.click();
    await expect(dialog.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByLabel('Username')).toBeVisible();
  });
}
