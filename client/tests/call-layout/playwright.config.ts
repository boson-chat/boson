import { defineConfig, devices } from '@playwright/test';

// The call screen's layout on phones, through the screenshot harness
// (src/renderer/src/shots.tsx) on the renderer-only Vite server. CI runs it
// in the Desktop app (Playwright) job.
//
//   npx playwright test -c tests/call-layout/playwright.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5197', colorScheme: 'dark' },
  webServer: {
    command: 'npx vite --config vite.config.ts --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197/shots.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
