import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');
const BACKUP_PATH = resolve(process.cwd(), '.env.e2e-backup');
const MARKER_PATH = resolve(process.cwd(), '.env.e2e-active');

// Server listings live in the directory service (boson-chat/directory) now,
// not in the backend's Postgres, so there is no `servers` table to sweep
// test rows out of here any more.
async function globalTeardown(): Promise<void> {
  if (existsSync(BACKUP_PATH)) {
    copyFileSync(BACKUP_PATH, ENV_PATH);
    unlinkSync(BACKUP_PATH);
  }
  if (existsSync(MARKER_PATH)) {
    unlinkSync(MARKER_PATH);
  }
}

export default globalTeardown;
