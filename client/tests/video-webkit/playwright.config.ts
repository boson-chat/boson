import { defineConfig, devices } from '@playwright/test';

// Real video in WebKit (the engine of the iOS and macOS apps' webviews):
// desktop/video_webkit_test.go feeds real H.264 frames and self-view
// previews through the app's real frame hub and runs this with FRAME_URL
// set. Chromium runs it too, as a reference.
//
//   cd desktop && go test -tags webkit -run TestVideoInWebKit .
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5281' },
  webServer: {
    command: 'npx vite --config vite.config.ts --host 127.0.0.1 --port 5281 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:5281/shots.html',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    { name: 'webkit-iphone', use: { ...devices['iPhone 13 Pro'], browserName: 'webkit' } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
