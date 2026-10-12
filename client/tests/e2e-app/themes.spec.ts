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
    expect(await cssVar(page, '--accent')).toBe('#ff4d8d');
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
