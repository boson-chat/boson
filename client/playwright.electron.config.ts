import { defineConfig } from '@playwright/test';

// Real-app e2e: drives the BUILT Electron app (out-e2e/, from
// `npm run build:e2e-app`) with its own engine sidecar, against the isolated
// IRC infra in infra/e2e/docker-compose.yml (ergo :16667, ZNC :16501).
// No backend / Supabase needed — the app runs in guest mode.
//
//   make test-e2e-app            # infra up + build + run
//   npm run test:e2e:app         # just run (infra + build already done)
//   make test-e2e-app-coverage   # same, plus coverage → coverage/e2e/
//
// Separate from playwright.config.ts, which runs the renderer in a browser
// against the full dev stack.
export default defineConfig({
  testDir: './tests/e2e-app',
  globalSetup: './tests/e2e-app/global-setup.ts',
  // Writes the coverage reports when E2E_COVERAGE=1.
  globalTeardown: './tests/e2e-app/global-teardown.ts',
  outputDir: './test-results/e2e-app',
  // Each test boots Electron (and an engine) at least once; bouncer flows
  // wait on ZNC's reconnect pacing.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // One app at a time: the bouncer spec shares a single ZNC network, and
  // several Electron instances fight over window focus on macOS.
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI']
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report/e2e-app' }]]
    : [['list']],
});
