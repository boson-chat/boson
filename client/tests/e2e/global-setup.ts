import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

// Vite reads .env files at server startup. The webServer.env field passed
// to playwright.config.ts is added to the spawned process's env vars, but
// values defined in client/.env take precedence because Vite loads them
// last in the merge order. To make the test's engine URL+token effective,
// we rewrite client/.env around the test run (with a backup so we never
// lose the user's real values).

const ENV_PATH = resolve(process.cwd(), '.env');
const BACKUP_PATH = resolve(process.cwd(), '.env.e2e-backup');
const MARKER_PATH = resolve(process.cwd(), '.env.e2e-active');

const TEST_TOKEN = 'e2e-test-token-do-not-use-in-prod';
// Must match the engine address in playwright.config.ts (:7332, not :7331).
const TEST_URL = 'ws://127.0.0.1:7332/ws';

async function globalSetup(): Promise<void> {
  if (existsSync(MARKER_PATH)) {
    // A previous run crashed before teardown — restore now so we start clean.
    if (existsSync(BACKUP_PATH)) {
      copyFileSync(BACKUP_PATH, ENV_PATH);
      unlinkSync(BACKUP_PATH);
    }
    unlinkSync(MARKER_PATH);
  }

  if (existsSync(ENV_PATH)) {
    copyFileSync(ENV_PATH, BACKUP_PATH);
  }

  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  // Strip any existing engine entries, then append the test values.
  const filtered = existing
    .split('\n')
    .filter((line) => !/^VITE_ENGINE_(URL|TOKEN)=/.test(line))
    .join('\n')
    .replace(/\n+$/, '');

  const withTest = `${filtered}\nVITE_ENGINE_URL=${TEST_URL}\nVITE_ENGINE_TOKEN=${TEST_TOKEN}\n`;
  writeFileSync(ENV_PATH, withTest);

  // Marker so teardown knows it has work to do (and recovery on next run if we crash).
  writeFileSync(MARKER_PATH, new Date().toISOString());
}

export default globalSetup;
