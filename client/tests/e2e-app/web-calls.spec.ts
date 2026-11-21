// Calls in the browser (the web build only): two signed-in people join the
// same voice channel through the app's UI and talk over WebTransport —
// quicvoiced 1.15 (Opus datagrams, the control stream) and quicvideod
// (camera tracks) from the e2e stack, both with self-signed dev
// certificates the page pins by hash. The browsers' fake devices stand in
// for the mic (a tone) and the camera (a test pattern).
//
// Proves: voice discovery from a boson.json, the room list, joining from
// the pre-join view, each side seeing the other in the channel, the other
// one's speaking indicator from their audio, the camera going out and
// arriving as decoded pictures, and leaving.
//
// The desktop e2e build has no voice audio (novoiceaudio), so it skips.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  test, expect, IS_WEB, STACK, IRC_HOST, IRC_PORT, addServerManually, loginAs, serverCard, uid, type Profile,
} from './fixtures';

test.skip(!IS_WEB, 'the desktop e2e build has no voice audio (novoiceaudio); calls are checked on the web build');
// Linux WebKit (WebKitGTK) has no WebTransport: the app shows chat only there.
test.skip(({ browserName }) => browserName === 'webkit' && process.platform === 'linux', 'Linux WebKit has no WebTransport');
// Known gap: headless Firefox on Linux CI joins no one (passes on macOS); to fix.
test.fixme(({ browserName }) => browserName === 'firefox' && process.platform === 'linux', 'headless Firefox on Linux CI: the call never joins; to fix');

function profile(): Profile {
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'boson-e2e-'));
  const p = { root, home: join(root, 'home'), runtime: join(root, 'run'), userData: join(root, 'userData') };
  for (const d of [p.home, p.runtime, p.userData]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return p;
}

// The e2e IRC server's boson.json: its voice server and auth service.
function networkJson(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boson-voice-'));
  const file = join(dir, 'boson.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    irc: { host: IRC_HOST, port: IRC_PORT, tls: false },
    auth: { url: STACK.auth.url },
    voice: { addr: STACK.voice.addr, url: STACK.voice.url },
  }));
  return file;
}

async function connect(page: Page, name: string): Promise<void> {
  await addServerManually(page, { hostname: IRC_HOST, port: IRC_PORT, name });
  await serverCard(page, name).getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.sidebar-status-dot')).toHaveAttribute('data-state', 'connected', { timeout: 30_000 });
}

async function joinGeneral(page: Page): Promise<void> {
  await page.getByLabel('Voice channel General', { exact: true }).click();
  await page.getByRole('button', { name: 'Join call' }).click();
}

// How much a canvas's picture varies (0: blank or one colour).
async function pictureVariance(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    let best = 0;
    for (const c of document.querySelectorAll<HTMLCanvasElement>(sel)) {
      if (!c.width || !c.height) continue;
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let min = 255;
      let max = 0;
      for (let i = 0; i < d.length; i += 4 * 97) { min = Math.min(min, d[i]!); max = Math.max(max, d[i]!); }
      best = Math.max(best, max - min);
    }
    return best;
  }, selector);
}

test.describe('calls in the browser', () => {
  test('two people join a voice channel, see each other speak, and see a camera', async ({ launchApp, createAccount, browserName }, testInfo) => {
    test.setTimeout(240_000);
    // Voice only (BOSON_VOICE_JSON): with the whole document the app would
    // sign in to the e2e ergo with the account (OAUTHBEARER), which it lacks.
    const env = { BOSON_VOICE_JSON: networkJson() };
    const [alice, bob] = await Promise.all([createAccount({ handle: true }), createAccount({ handle: true })]);
    const p2 = profile();
    try {
      const a = await launchApp({ env });
      const b = await launchApp({ env, profile: p2 });
      const name = `Voice ${uid()}`;
      await test.step('sign in and connect', async () => {
        await loginAs(a.page, alice);
        await loginAs(b.page, bob);
        await connect(a.page, name);
        await connect(b.page, name);
      });

      await test.step('both join General', async () => {
        // The voice channels from the voice server's room list.
        await expect(a.page.getByLabel('Voice channel General', { exact: true })).toBeVisible({ timeout: 30_000 });
        await joinGeneral(a.page);
        await joinGeneral(b.page);
        // Each sees both in the channel.
        for (const page of [a.page, b.page]) {
          const room = page.locator('.voice-room[data-room="general"]');
          await expect(room.locator('.voice-participant')).toHaveCount(2, { timeout: 30_000 });
        }
        await expect(a.page.locator('.voice-room[data-room="general"] .voice-participant', { hasText: bob.username })).toBeVisible();
      });

      await test.step("Bob's voice reaches Alice", async () => {
        // Bob's mic (the fake device's tone): his speaking ring at Alice's.
        await expect(a.page.locator('.voice-participant-speaking', { hasText: bob.username })).toBeVisible({ timeout: 30_000 });
        await a.page.screenshot({ path: testInfo.outputPath(`call-${browserName}.png`) });
      });

      await test.step("Bob's camera reaches Alice as pictures", async () => {
        const cam = b.page.getByRole('button', { name: 'Turn camera on' }).first();
        await expect(cam).toBeEnabled({ timeout: 30_000 });
        await cam.click();
        await expect(b.page.getByRole('button', { name: 'Turn camera off' }).first()).toBeVisible({ timeout: 30_000 });
        const show = a.page.getByRole('button', { name: 'Show the call' }).first();
        if (await show.isVisible().catch(() => false)) await show.click();
        await expect.poll(() => pictureVariance(a.page, 'canvas.stage-video'), { timeout: 45_000 }).toBeGreaterThan(10);
        await a.page.screenshot({ path: testInfo.outputPath(`camera-${browserName}.png`) });
      });

      await test.step('Bob leaves', async () => {
        await b.page.getByRole('button', { name: /^Leave/ }).first().click();
        await expect(a.page.locator('.voice-room[data-room="general"] .voice-participant')).toHaveCount(1, { timeout: 30_000 });
      });
    } finally {
      rmSync(p2.root, { recursive: true, force: true });
    }
  });
});
