// Themes end to end: pick a built-in (sticks across relaunch), customize one
// in Settings → Appearance (written to <userData>/themes/<id>.json), edit
// that file outside the app (re-applied live), and drop a new file in
// (listed; a broken one is reported).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, uid, continueAsGuest } from './fixtures';
import type { Page } from '@playwright/test';

const cssVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'User settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'User settings' });
  await dialog.getByRole('tab', { name: /Appearance/ }).click();
  return dialog;
}

test.describe('themes', () => {
  test('a built-in theme applies at once and survives a relaunch', async ({ launchApp }) => {
    const first = await launchApp();
    await continueAsGuest(first.page, `th${uid()}`);
    expect(await cssVar(first.page, '--bg')).toBe('#070709');

    const dialog = await openAppearance(first.page);
    await dialog.getByRole('radio', { name: /^Daylight/ }).click();
    await expect(dialog.getByRole('radio', { name: /^Daylight/ })).toHaveAttribute('aria-checked', 'true');
    expect(await cssVar(first.page, '--bg')).toBe('#F4F4F0');
    expect(await first.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(244, 244, 240)');
    await first.app.close();

    const again = await launchApp();
    await expect.poll(() => cssVar(again.page, '--bg')).toBe('#F4F4F0');
    expect(await again.page.evaluate(() => document.documentElement.dataset['themeBase'])).toBe('light');
  });

  test('a custom theme can round the corners and use the system font', async ({ launchApp }) => {
    const { page } = await launchApp();
    await continueAsGuest(page, `th${uid()}`);
    const dialog = await openAppearance(page);
    await dialog.getByRole('button', { name: 'Customize Terminal' }).click();
    await dialog.getByRole('slider', { name: 'Corner radius' }).fill('4');
    await dialog.getByRole('radio', { name: 'System font' }).check();
    await expect.poll(() => cssVar(page, '--radius-md')).toBe('8px');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Segoe UI');
    // Real controls pick it up (once their own transition settles).
    const save = dialog.getByRole('button', { name: 'Save as new theme' });
    await expect.poll(() => save.evaluate((el) => getComputedStyle(el).borderTopLeftRadius))
      .toMatch(/^(4|8|12)px$/);
  });

  // The colour picker opens over the settings dialog (rendered into <body>
  // so the dialog can't clip it), drives the live preview, and closing it
  // (Escape, a click elsewhere) leaves the dialog open.
  test('the colour picker previews live and saves, without closing the settings', async ({ launchApp, profile }) => {
    const { page } = await launchApp();
    await continueAsGuest(page, `th${uid()}`);
    const dialog = await openAppearance(page);
    await dialog.getByRole('button', { name: 'Customize Terminal' }).click();
    await dialog.getByLabel('Name').fill('Picked');

    const swatch = dialog.getByRole('button', { name: 'Accent colour picker', exact: true });
    await swatch.click();
    const pick = page.getByRole('dialog', { name: 'Pick Accent' });
    await expect(pick).toBeVisible();
    // Fully inside the window, next to its swatch.
    const [p, s] = [(await pick.boundingBox())!, (await swatch.boundingBox())!];
    expect(p.y + p.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
    expect(Math.abs(p.y - (s.y + s.height)) < 12 || Math.abs(p.y + p.height - s.y) < 12).toBe(true);

    // Hue to green at full saturation/brightness (Terminal's accent is an orange).
    await pick.getByRole('textbox', { name: 'Hex' }).fill('#ff0000');
    await pick.getByRole('slider', { name: 'Hue' }).fill('120');
    await expect.poll(() => cssVar(page, '--accent')).toBe('#00ff00');
    await expect(dialog.getByRole('textbox', { name: 'Accent', exact: true })).toHaveValue('#00ff00');
    // Drag in the square: bottom-left is black.
    const square = (await pick.locator('.color-picker-area').boundingBox())!;
    await page.mouse.move(square.x + 1, square.y + square.height - 1);
    await page.mouse.down();
    await page.mouse.move(square.x + square.width / 2, square.y + square.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => cssVar(page, '--accent')).toMatch(/^#[0-9a-f]{6}$/);
    expect(await cssVar(page, '--accent')).not.toBe('#00ff00');
    // A swatch chip reuses another theme colour.
    await pick.getByRole('button', { name: 'Use #10b981' }).click();
    await expect.poll(() => cssVar(page, '--accent')).toBe('#10b981');

    await page.keyboard.press('Escape');
    await expect(pick).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(swatch).toBeFocused();
    await swatch.click();
    await expect(pick).toBeVisible();
    await dialog.getByLabel('Name').click(); // elsewhere in the dialog
    await expect(pick).toBeHidden();
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Save as new theme' }).click();
    await expect(dialog.getByRole('radio', { name: /^Picked/ })).toHaveAttribute('aria-checked', 'true');
    const file = join(profile.userData, 'themes', 'picked.json');
    await expect.poll(() => { try { return JSON.parse(readFileSync(file, 'utf8')).colors.accent; } catch { return null; } })
      .toBe('#10b981');
  });

  test('customize writes a theme file, and editing the file updates the app live', async ({ launchApp, profile }) => {
    const { page } = await launchApp();
    await continueAsGuest(page, `th${uid()}`);
    const themesDir = join(profile.userData, 'themes');

    let dialog = await openAppearance(page);
    await dialog.getByRole('radio', { name: /^Nord/ }).click();
    await dialog.getByRole('button', { name: 'Customize Nord' }).click();
    await dialog.getByLabel('Name').fill('Night Shift');
    await dialog.getByRole('textbox', { name: 'Accent', exact: true }).fill('#ff4d8d');
    // Live preview before saving.
    await expect.poll(() => cssVar(page, '--accent')).toBe('#ff4d8d');
    await dialog.getByRole('button', { name: 'Save as new theme' }).click();
    await expect(dialog.getByRole('radio', { name: /^Night Shift/ })).toHaveAttribute('aria-checked', 'true');

    const file = join(themesDir, 'night-shift.json');
    await expect.poll(() => readdirSync(themesDir)).toContain('night-shift.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toMatchObject({ name: 'Night Shift', base: 'dark', colors: { accent: '#ff4d8d', bg: '#242933' } });

    // Edited in a text editor: the app follows without a restart.
    saved.colors.accent = '#22d3ee';
    writeFileSync(file, JSON.stringify(saved, null, 2));
    await expect.poll(() => cssVar(page, '--accent'), { timeout: 10_000 }).toBe('#22d3ee');

    // A new file is listed; a broken one is reported, not fatal.
    writeFileSync(join(themesDir, 'paper.json'), JSON.stringify({ name: 'Paper', base: 'light' }));
    writeFileSync(join(themesDir, 'broken.json'), '{ "name": ');
    await page.keyboard.press('Escape');
    dialog = await openAppearance(page);
    await expect(dialog.getByRole('radio', { name: /^Paper/ })).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole('list', { name: 'Theme files with errors' })).toContainText('broken.json');

    // Delete the active custom theme: back to a built-in, file gone.
    await dialog.getByRole('radio', { name: /^Night Shift/ }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete theme' }).click();
    await expect(dialog.getByRole('radio', { name: /^Terminal/ })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => readdirSync(themesDir)).not.toContain('night-shift.json');
  });
});
