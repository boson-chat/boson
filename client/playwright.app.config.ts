import { defineConfig } from '@playwright/test';

// Real-app e2e: drives the BUILT desktop app (desktop/, as a server-mode
// binary embedding out-e2e/renderer, from `npm run build:e2e-app`) in
// Chromium, against the isolated e2e stack (scripts/e2e-stack.mjs: ergo,
// ZNC, Supabase Auth, the backend, … — endpoints in infra/e2e/stack.json).
// Guest specs only need ergo + ZNC; account specs need all of it.
//
//   make test-e2e-app            # stack up + build + run
//   npm run test:e2e:app         # just run (stack + build already done)
//   make test-e2e-app-coverage   # same, plus coverage → coverage/e2e/
//
// Separate from playwright.config.ts, which runs the renderer in a browser
// against the full dev stack.
export default defineConfig({
  testDir: './tests/e2e-app',
  globalSetup: './tests/e2e-app/global-setup.ts',
  // Writes the coverage reports when E2E_COVERAGE=1.
  globalTeardown: './tests/e2e-app/global-teardown.ts',
  // Separate per concurrently running author (like E2E_OUT_DIR).
  outputDir: process.env['E2E_RESULTS_DIR'] || './test-results/e2e-app',
  // Each test boots the app (and its engine) at least once; bouncer flows
  // wait on ZNC's reconnect pacing.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Tests are independent: each gets its own app profile, random channels /
  // nicks / users, and its own leased ZNC user (zncUser fixture). Locally 4
  // apps run side by side (measured stable on macOS: 3/3 runs, ~2.5x
  // faster); CI sets its own count (E2E_WORKERS), which overrides both.
  fullyParallel: true,
  workers: Number(process.env['E2E_WORKERS'] || (process.env['CI'] ? 1 : 4)),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI']
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report/e2e-app' }]]
    : [['list']],
});
