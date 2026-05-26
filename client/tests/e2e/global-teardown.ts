import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ENV_PATH = resolve(process.cwd(), '.env');
const BACKUP_PATH = resolve(process.cwd(), '.env.e2e-backup');
const MARKER_PATH = resolve(process.cwd(), '.env.e2e-active');

// Tests register servers with these name prefixes — see auth-flow.spec.ts,
// chat.spec.ts, engine-connect.spec.ts. Wipe them so the dev directory
// doesn't get buried under hundreds of test rows over time.
const TEST_NAME_PREFIXES = [
  'AuthSeed-',
  'SrchMatch-',
  'SrchOther-',
  'LocalErgo-',
  'ChatErgo-',
  'TLSCheck',
];

async function globalTeardown(): Promise<void> {
  if (existsSync(BACKUP_PATH)) {
    copyFileSync(BACKUP_PATH, ENV_PATH);
    unlinkSync(BACKUP_PATH);
  }
  if (existsSync(MARKER_PATH)) {
    unlinkSync(MARKER_PATH);
  }

  // Clean up servers registered by the tests. The boson Postgres lives in
  // docker-compose, so we go via `docker compose exec` rather than adding a
  // node-postgres dependency just for this. Best-effort — never fail the
  // suite on cleanup errors.
  const whereClauses = TEST_NAME_PREFIXES.map((p) => `name LIKE '${p}%'`).join(' OR ');
  const sql = `DELETE FROM servers WHERE ${whereClauses};`;

  const res = spawnSync(
    'docker',
    ['compose', '-f', '../docker-compose.yml', 'exec', '-T', 'postgres', 'psql', '-U', 'boson', '-d', 'boson', '-c', sql],
    { stdio: 'pipe' },
  );

  if (res.status !== 0) {
    // Surface but don't throw — cleanup is opportunistic.
    const stderr = (res.stderr ?? Buffer.from('')).toString().trim();
    if (stderr) console.warn('[e2e teardown] server cleanup skipped:', stderr.split('\n').pop());
  }
}

export default globalTeardown;
