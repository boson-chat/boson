import { defineConfig, devices } from '@playwright/test';

// Website screenshots of the real screens with mock data, via the
// screenshot harness (src/renderer/src/shots.tsx, served at /shots.html by
// the renderer-only Vite server). Writes PNGs into website/public/screenshots.
//
//   npx playwright test -c tests/shots/playwright.shots.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: '*.shots.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    // The installed Chrome; no Playwright browser download needed.
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5199',
    viewport: { width: 1440, height: 900 },
    // 2x: the site shows these on high-density screens, and docs crops
    // are displayed at their CSS size (see ScreenshotFrame maxWidth).
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  },
  // Its own port, always a fresh server: 5173 (the renderer's usual port)
  // may be taken by another Vite app, which would otherwise be "reused".
  webServer: {
    command: 'npx vite --config vite.renderer.config.ts --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199/shots.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
