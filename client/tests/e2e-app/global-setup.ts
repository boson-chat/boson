// Fail fast (with instructions) when the app build or the IRC infra is
// missing, instead of every test timing out one by one.
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { APP_DIR, IRC_HOST, IRC_PORT, ZNC_HOST, ZNC_PORT } from './fixtures';

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
  if (!existsSync(join(APP_DIR, 'package.json')) || !existsSync(join(APP_DIR, 'main', 'index.js'))) {
    problems.push(`app build missing at ${APP_DIR} — run \`npm run build:e2e-app\``);
  }
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const engine = join(APP_DIR, 'resources', 'engine', `engine-${os}-${arch}${os === 'windows' ? '.exe' : ''}`);
  if (!existsSync(engine)) problems.push(`engine sidecar missing at ${engine} — run \`npm run build:e2e-app\``);
  if (!(await probe(IRC_HOST, IRC_PORT))) problems.push(`ergo not reachable on ${IRC_HOST}:${IRC_PORT}`);
  if (!(await probe(ZNC_HOST, ZNC_PORT))) problems.push(`ZNC not reachable on ${ZNC_HOST}:${ZNC_PORT}`);
  if (problems.length > 0) {
    throw new Error(
      'Real-app e2e prerequisites missing:\n  - ' + problems.join('\n  - ') +
      '\nBring up the infra with `docker compose -f infra/e2e/docker-compose.yml up -d --wait` ' +
      '(from the repo root) or just run `make test-e2e-app`.',
    );
  }
}
