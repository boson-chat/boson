// Full-stack NickServ flow: Electron renderer → engine IPC → real IRC
// services container → reply → classifier → UI badge. Closes the
// "Layer 4" gap (engine.services_e2e covers engine↔server,
// classifier fixtures cover classifier↔ground-truth,
// ServerSettings.identity.test.tsx covers UI↔store-mocked — but only
// this spec proves the whole pipeline actually works wire-to-pixel).
//
// Parameterised via env so the same spec runs against any of the
// three services stacks:
//
//   E2E_IRC_HOST   default 'localhost'
//   E2E_IRC_PORT   default 6667  (ergo)
//   E2E_STACK_NAME default 'ergo'
//
// `make test-e2e-services-{ergo,anope,atheme}` sets these to the
// appropriate values + boots the docker profile for that stack.
//
// Stack required (`make dev-up` brings it all):
//   - postgres + supabase + ergo (testing profile)
//   - boson backend on :3000 (`make run` in another shell)
//   - engine + renderer launched by playwright.config.ts webServer
//
// Per-stack docker profiles bring up Anope or Atheme on their own
// ports (6668 / 6669) — those don't need a separate make target;
// the test-e2e-services-* targets do `docker compose --profile
// <stack> up -d` before invoking this spec.
//
// IRC-side config notes:
//   - Ergo  : `enabled-callbacks: [none]` in infra/ergo/ircd.yaml
//   - Anope : `registration = "none"` in infra/anope/conf/nickserv.conf
//   - Atheme: `auth = none;` in infra/atheme/atheme.conf
// All three skip email confirmation so REGISTER lands at the
// classifier's `registration-confirmed` kind in one round-trip.
import { test, expect } from '@playwright/test';

const STACK_NAME = process.env.E2E_STACK_NAME ?? 'ergo';

// Each stack has a pre-seeded verified directory entry created by
// backend/db/seeds/dev-<stack>.sql (applied by the Make targets
// before this spec runs). Look it up by name rather than registering
// a new server per-test — fresh registrations land in `pending`
// status and the public GET /servers filters those out.
const STACK_SERVER_NAMES: Record<string, string> = {
  ergo:   'Local Ergo',
  anope:  'Local Anope',
  atheme: 'Local Atheme',
};

const SERVER_NAME = STACK_SERVER_NAMES[STACK_NAME] ?? STACK_SERVER_NAMES.ergo!;

function uniqueEmail(prefix = 'nickserv'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}@local.dev`;
}

test.describe(`NickServ flow — full stack against ${STACK_NAME}`, () => {
  test('register lands the badge at Identified through real IPC + IRC round-trip', async ({ page }) => {
    const email = uniqueEmail();
    const password = 'testtest';
    const ircPassword = `pw-${Date.now()}`;
    // Ergo with callbacks=none ignores the email; Anope + Atheme
    // with their respective `none` configs also skip the mailer.
    const ircEmail = 'nobody@test.invalid';

    // ---- UI sign-up — drives identity-key derivation through the
    // real LoginScreen flow. The chat.spec.ts approach (API signup +
    // placeholder encrypted blob) is flaky because the renderer
    // can't decrypt the placeholder bytes; doing the sign-up via
    // the UI lets the LoginBloc derive a fresh key from the
    // password and POST the proper ciphertext. The LoginBloc was
    // patched (same PR as this spec) to also handle the case where
    // Supabase has email-confirmation disabled and returns a
    // session immediately on signup.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Boson' })).toBeVisible();
    await page.getByPlaceholder('email').fill(email);
    await page.getByPlaceholder('password').fill(password);
    await page.getByRole('button', { name: 'Sign up' }).click();

    // After signup the renderer routes through SetupPrompt → fill
    // a handle → Save → DirectoryScreen with @handle visible.
    await expect(page.getByText('Finish setting up your account')).toBeVisible({ timeout: 15_000 });
    const handle = 'n' + Date.now().toString().slice(-9);
    await page.getByPlaceholder('handle').fill(handle);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(`@${handle}`)).toBeVisible({ timeout: 15_000 });

    // ---- Connect to the IRC stack -------------------------------
    // Look up the pre-seeded server (backend/db/seeds/dev-<stack>.sql
    // applied by the per-stack make target). Public GET /servers
    // filters out `pending` rows, so registering a fresh server
    // per-test would never appear in the directory list.
    await page.getByPlaceholder('Search servers…').fill(SERVER_NAME);
    // Heading text is "<name> <STATUS>" (e.g., "Local Ergo ONLINE"),
    // so we match by prefix rather than exact text. The card itself
    // is `.directory-card` (chat.spec.ts uses `.directory-list-item`
    // which is stale — that class no longer exists in DirectoryScreen).
    const card = page.locator('.directory-card', {
      has: page.getByRole('heading', { name: new RegExp(`^${SERVER_NAME}\\b`) }),
    });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('.channel-sidebar')).toBeVisible({ timeout: 20_000 });

    // Wait for the IRC handshake to fully settle. The channel-sidebar
    // appears as soon as RPL_WELCOME (001) lands, but NickServ may
    // not have introduced itself yet — the classifier needs at least
    // one service-class NOTICE for its dispatch to recognise the
    // sender. Without this wait, REGISTER goes out before the engine
    // has fully wired up service routing and the reply gets
    // misclassified or dropped. Verified live via the Playwright MCP
    // debug session: same flow works instantly given ~2s of settle
    // time, fails with status stuck at 'Registering...' without it.
    await page.waitForTimeout(2_000);

    // ---- Open Server settings → Identity tab --------------------
    await page.getByRole('button', { name: 'Server details' }).click();
    await page.getByRole('tab', { name: /Identity/ }).click();

    // ---- Register a fresh NickServ account ----------------------
    await page.locator('input[type="password"]').first().fill(ircPassword);
    await page.locator('input[placeholder="you@example.com"]').first().fill(ircEmail);
    await page.getByRole('button', { name: 'Register new account' }).click();

    // ---- Wait for the badge to flip to Identified ---------------
    // Pipeline: IRC replies the stack-specific success line →
    // engine forwards → classifier maps to registration-confirmed
    // → ChatService auto-fires IDENTIFY → next reply lands at
    // 'identified' → ServicesStatusPanel renders "Identified as <X>".
    await expect(page.getByText(/Identified as/)).toBeVisible({ timeout: 20_000 });
  });
});
