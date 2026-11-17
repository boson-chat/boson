import { defineConfig } from '@playwright/test';

// desktop/scripts/android-call-test.sh runs this against an emulator.
export default defineConfig({
  testDir: '.',
  timeout: 300_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
});
