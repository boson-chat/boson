// The Android real-call camera test: the app on an emulator joins a voice
// channel and turns its camera on; callprobe (desktop/cmd/callprobe), a
// second participant on this machine, says whether that camera arrives as
// real, moving video. Run by desktop/scripts/android-call-test.sh, which
// boots the emulator, installs the dev APK and starts the servers.
//
// Local (default): the e2e stack (its auth for the app's sign-in; auth2 +
// ergo2 as a self-hosted network) with a local quicvoiced (AUTH_INSECURE)
// and quicvideod. The app signs in and signs up with throwaway accounts on
// the stack's tmpfs auth services, like the e2e suite does.
//
// Production: ANDROID_CALL_USER / ANDROID_CALL_PASSWORD sign the app in to
// boson.chat; ANDROID_CALL_SERVER and ANDROID_CALL_VOICE name the server
// card and the voice channel to join. callprobe then needs a voice token
// for the same account (the script gets one; quicvoice lets one account
// be in a call from two devices).
import { _android, expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createConfirmedUser } from '../e2e-app/helpers/auth';
import { completeHandleSetup } from '../e2e-app/helpers/account';
import { randomHandle } from '../e2e-app/helpers/backend';

const PROD = !!process.env['ANDROID_CALL_USER'];
const VOICE = process.env['ANDROID_CALL_VOICE'] ?? 'General';
const PROBE = process.env['CALLPROBE'] ?? '';
const PROBE_ARGS = (process.env['CALLPROBE_ARGS'] ?? '').split(' ').filter(Boolean);
const SHOTS = process.env['ANDROID_CALL_SHOTS'] ?? '';
const uid = () => Math.random().toString(36).slice(2, 8);

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

function runProbe(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(PROBE, PROBE_ARGS);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

test('the phone\'s camera reaches the other side of a real call', async () => {
  test.setTimeout(300_000);
  expect(PROBE, 'CALLPROBE: the probe binary').not.toBe('');
  const [device] = await _android.devices();
  expect(device, 'an emulator or phone on adb').toBeTruthy();
  try {
    const page = await (await device.webView({ pkg: 'chat.boson.app' })).page();
    await shot(page, '01-start');

    if (PROD) {
      await page.getByPlaceholder('email').first().fill(process.env['ANDROID_CALL_USER']!);
      await page.getByPlaceholder('password').first().fill(process.env['ANDROID_CALL_PASSWORD']!);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const server = process.env['ANDROID_CALL_SERVER'] ?? 'Boson';
      await page.locator('article.directory-card').filter({ hasText: server }).getByRole('button', { name: 'Connect' }).click();
    } else {
      // Signed in to the stack's own auth (voice is for signed-in users;
      // a throwaway account on its tmpfs database), then the self-hosted
      // network's account.
      const { username: user, password: pw } = await createConfirmedUser();
      await page.getByPlaceholder('email').first().fill(user);
      await page.getByPlaceholder('password').first().fill(pw);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      // A new account picks its handle first (a cold emulator signs in slowly).
      await expect(page.getByRole('heading', { name: 'Finish setting up your account' })).toBeVisible({ timeout: 60_000 });
      await completeHandleSetup(page as never, randomHandle('droid'));
      await expect(page.getByRole('heading', { name: 'Server Directory' })).toBeVisible({ timeout: 30_000 });
      const name = `Local ${uid()}`;
      await page.getByRole('button', { name: 'Advanced', exact: true }).click();
      await page.getByRole('button', { name: '+ Add server manually' }).click();
      const add = page.getByRole('dialog', { name: 'Add a server manually' });
      const fieldOf = (label: string) => add.locator('.bds-field').filter({ hasText: label }).locator('input').first();
      await fieldOf('Hostname').fill('10.0.2.2');
      await fieldOf('Port').fill('16668');
      await fieldOf('Display name').fill(name);
      const tls = add.getByRole('checkbox', { name: 'Use TLS (recommended)' });
      if (await tls.isChecked()) await add.getByText('Use TLS (recommended)').click();
      await add.getByRole('button', { name: /^Add/ }).click();
      await page.locator('article.directory-card').filter({ hasText: name }).getByRole('button', { name: 'Connect' }).click();
      const signin = page.getByRole('dialog', { name: `Sign in to ${name}` });
      await expect(signin).toBeVisible({ timeout: 30_000 });
      await signin.getByRole('tab', { name: 'Create account' }).click();
      await signin.getByPlaceholder('username', { exact: true }).fill(`droid${uid()}`);
      await signin.getByPlaceholder('email', { exact: true }).fill(`droid-${uid()}@example.test`);
      await signin.getByPlaceholder('password', { exact: true }).fill(`pw-${uid()}-${uid()}-Aa1`);
      await signin.getByRole('button', { name: 'Create account' }).click();
      await expect(signin).toBeHidden({ timeout: 30_000 });
    }
    await shot(page, '02-connected');

    // Into the voice channel, camera on.
    const row = page.getByRole('button', { name: `Voice channel ${VOICE}` }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click();
    await shot(page, '03-prejoin');
    await page.getByRole('button', { name: 'Join call' }).first().click();
    await expect(page.getByRole('button', { name: 'Leave call' }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Turn camera on' }).first().click();
    await expect(page.getByRole('button', { name: 'Turn camera off' }).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, '04-camera-on');

    // The other side.
    const { code, out } = await runProbe();
    console.log(`callprobe: ${out.trim()}`);
    await shot(page, '05-after-probe');
    expect(code, out).toBe(0);
  } finally {
    await device.close();
  }
});
