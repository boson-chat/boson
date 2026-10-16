// Fail fast (with instructions) when the app build or the IRC infra is
// missing, instead of every test timing out one by one.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { APP_DIR, IRC_HOST, IRC_PORT, ZNC_HOST, ZNC_PORT } from './fixtures';
import { STACK } from './stack';
import { COVERAGE, COVERAGE_DIR, RAW } from './coverage/config';
import { APP_BIN } from './desktop-app';

function probe(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port });
    const done = (ok: boolean): void => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export default async function globalSetup(): Promise<void> {
  const problems: string[] = [];
  // The server-mode binary embeds the renderer; the coverage report maps
  // the renderer chunks back through out-e2e/renderer's source maps.
  if (!existsSync(APP_BIN)) problems.push(`${APP_BIN} is missing — run \`npm run build:e2e-app\``);
  if (COVERAGE && !readdirSync(join(APP_DIR, 'renderer', 'assets')).some((f) => f.endsWith('.js.map'))) {
    problems.push(`E2E_COVERAGE=1 but ${APP_DIR}/renderer is not a coverage build — run \`E2E_COVERAGE=1 npm run build:e2e-app\``);
  }
  if (!(await probe(IRC_HOST, IRC_PORT))) problems.push(`ergo not reachable on ${IRC_HOST}:${IRC_PORT}`);
  if (!(await probe(ZNC_HOST, ZNC_PORT))) problems.push(`ZNC not reachable on ${ZNC_HOST}:${ZNC_PORT}`);
  if (problems.length > 0) {
    throw new Error(
      'Real-app e2e prerequisites missing:\n  - ' + problems.join('\n  - ') +
      '\nBring up the infra with `make test-e2e-app-up` (repo root) or just run `make test-e2e-app`.',
    );
  }

  // Account-mode specs need the rest of the stack; guest-only runs don't,
  // so this only warns (the account fixtures fail fast with the details).
  const backendUp = await fetch(`${STACK.backend.url}/health`, { signal: AbortSignal.timeout(3_000) })
    .then((r) => r.ok, () => false);
  if (!backendUp) {
    console.warn(`[e2e] backend not reachable on ${STACK.backend.url} — account-mode specs will fail. ` +
      'Bring the full stack up with `make test-e2e-app-up`.');
  }

  if (COVERAGE) {
    // Fresh run: drop the previous reports and raw data.
    rmSync(COVERAGE_DIR, { recursive: true, force: true });
    for (const d of [RAW.renderer, RAW.engine, RAW.launches]) mkdirSync(d, { recursive: true });
  }
}
