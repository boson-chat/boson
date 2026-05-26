import { defineConfig, devices } from '@playwright/test';

// E2E assumes the full local stack: postgres, supabase, boson backend, AND
// the local ergo IRCd in docker-compose. Bring it up via:
//   make dev-up           # postgres + supabase + ergo + migrations
//   make run              # boson backend in another shell
// Playwright launches the engine and the renderer Vite server itself.
const TEST_TOKEN = 'e2e-test-token-do-not-use-in-prod';
// :7332 — *not* :7331 — so test runs don't collide with a developer's
// `make engine-serve` running for the Electron app. The renderer's
// VITE_ENGINE_URL is overridden by globalSetup to point at this port.
const ENGINE_ADDR = '127.0.0.1:7332';
const ENGINE_URL = `ws://${ENGINE_ADDR}/ws`;

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      // Built by `make test-e2e` before playwright runs. Cuts cold start by
      // ~30s vs. `go run` (which recompiles each invocation).
      command: `../bin/engine serve --addr ${ENGINE_ADDR} --token-from-env`,
      url: `http://${ENGINE_ADDR}/health`,
      env: { BOSON_ENGINE_TOKEN: TEST_TOKEN },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev:renderer-only',
      url: 'http://localhost:5173',
      env: {
        VITE_ENGINE_URL: ENGINE_URL,
        VITE_ENGINE_TOKEN: TEST_TOKEN,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
