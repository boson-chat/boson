import { defineConfig, devices } from '@playwright/test';

// The call screen's layout on phones, through the screenshot harness
// (src/renderer/src/shots.tsx) on the renderer-only Vite server. CI runs it
// in the Desktop app (Playwright) job.
//
//   npx playwright test -c tests/call-layout/playwright.config.ts
//
// E2E_TARGET=web: the same specs in the three browser engines the web build
// (chat.boson.chat) runs in — projects web-chromium, web-firefox and
// web-webkit — since this is the renderer's own layout, not the shell's.
const web = process.env['E2E_TARGET'] === 'web';
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5197', colorScheme: 'dark' },
  projects: web
    ? [
      { name: 'web-chromium', use: { ...devices['Desktop Chrome'] } },
      { name: 'web-firefox', use: { ...devices['Desktop Firefox'] } },
      { name: 'web-webkit', use: { ...devices['Desktop Safari'] } },
    ]
    : [{ name: 'chromium' }],
  webServer: {
    command: 'npx vite --config vite.config.ts --host 127.0.0.1 --port 5197 --strictPort',
    url: 'http://127.0.0.1:5197/shots.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
