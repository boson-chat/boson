#!/usr/bin/env node
// Brings the real-app e2e stack up / down (client/tests/e2e-app/):
//
//   node scripts/e2e-stack.mjs up       # compose (incl. auth service) + migrations + backend
//   node scripts/e2e-stack.mjs down     # stop all of it, drop its state
//   node scripts/e2e-stack.mjs status
//   node scripts/e2e-stack.mjs restart-backend
//
// (`make test-e2e-app-up` / `make test-e2e-app-down` from the repo root.)
//
// Pieces, all on non-default loopback ports so they run next to the dev stack
// (endpoints in infra/e2e/stack.json):
//
//   1. infra/e2e/docker-compose.yml — compose project `boson-e2e`: ergo,
//      ZNC, the backend's Postgres, the catch-all Mailpit, MinIO (+ bucket),
//      and the boson auth service with its Postgres and the users' Mailpit.
//      The auth image is built from $AUTH_SRC (default: an `auth` checkout
//      next to this repo) unless $AUTH_IMAGE names one to use. `up` creates
//      the stack's admin account (stack.json auth.admin) for the tests.
//   2. The Go backend, built from this checkout into infra/e2e/.run/ and run
//      on the host (`serve`, after `migrate up`). Built with the `boson_dev`
//      tag + SKIP_DNS_VERIFY so directory servers can be verified without
//      DNS. With E2E_COVERAGE=1 it's a `-cover` build that flushes counters
//      on SIGUSR1 (backend/cmd/server/coverflush_e2e.go) for the coverage
//      report.
//
// The backend's working directory is infra/e2e/.run, where none of the
// backend/config/config.dev.json search paths resolve: everything comes from
// the env below, never a developer's local config (which may hold real mail
// credentials).
//
// `down` only ever stops what this script started: the compose project
// `boson-e2e` and the backend PID in
// infra/e2e/.run/backend.pid (after checking its command is our binary).
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(clientDir, '..');
const e2eDir = join(repoRoot, 'infra', 'e2e');
const runDir = join(e2eDir, '.run');
const stack = JSON.parse(readFileSync(join(e2eDir, 'stack.json'), 'utf8'));

const coverage = process.env.E2E_COVERAGE === '1';
const GO = process.env.GO ?? 'go';
const AUTH_IMAGE = process.env.AUTH_IMAGE ?? '';
const AUTH_SRC = process.env.AUTH_SRC ?? join(repoRoot, '..', 'auth');
const LOCAL_AUTH_IMAGE = 'boson-e2e-auth:local';
const backendBin = join(runDir, process.platform === 'win32' ? 'boson-e2e-backend.exe' : 'boson-e2e-backend');
const pidFile = join(runDir, 'backend.pid');
const logFile = join(runDir, 'backend.log');
export const backendCoverDir = join(runDir, 'backend-cover');

const compose = ['compose', '-f', join(e2eDir, 'docker-compose.yml')];
const COMPOSE_SERVICES = [
  'ergo', 'znc', 'postgres', 'mailpit-archive', 'mailpit', 'minio', 'auth-postgres', 'auth-mailpit', 'auth',
];

function log(msg) {
  console.log(`[e2e-stack] ${msg}`);
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (exit ${r.status ?? r.signal})`);
}

function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = String(err?.message ?? err);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last})` : ''}`);
}

// ---- compose ---------------------------------------------------------------

function composeUp() {
  prepareAuthImage();
  run('docker', [...compose, 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', ...COMPOSE_SERVICES], {
    env: { ...process.env, AUTH_IMAGE: AUTH_IMAGE || LOCAL_AUTH_IMAGE },
  });
  // One-shot bucket setup (loops until MinIO answers, then exits).
  run('docker', [...compose, 'run', '--rm', '--build', 'minio-setup']);
}

function composeDown() {
  run('docker', [...compose, 'down', '-v', '--remove-orphans']);
}

// ---- auth service ----------------------------------------------------------

// The auth service's image: $AUTH_IMAGE (pulled if missing), else built from
// the $AUTH_SRC checkout.
function prepareAuthImage() {
  if (AUTH_IMAGE) {
    if (!capture('docker', ['image', 'inspect', AUTH_IMAGE]).ok) run('docker', ['pull', AUTH_IMAGE]);
    return;
  }
  if (!existsSync(join(AUTH_SRC, 'Dockerfile'))) {
    throw new Error(`no auth service checkout at ${AUTH_SRC}: clone github.com/boson-chat/auth there, ` +
      'or set AUTH_SRC to one, or AUTH_IMAGE to a built image');
  }
  run('docker', ['build', '-q', '-t', LOCAL_AUTH_IMAGE, AUTH_SRC]);
}

async function authUp() {
  const auth = stack.auth;
  await waitFor(`auth service on ${auth.url}/readyz`, async () => (await fetch(`${auth.url}/readyz`)).ok, 60_000);
  // The tests' admin account (looks users up, disables them afterwards).
  // `user create` marks the email verified; rerunning on a live stack finds
  // it taken, which is fine.
  const r = spawnSync('docker', [...compose, 'exec', '-T', 'auth', './auth', 'user', 'create',
    '--username', auth.admin.username, '--email', auth.admin.email, '--role', 'admin', '--password-stdin'], {
    input: `${auth.admin.password}\n`, encoding: 'utf8', env: { ...process.env, AUTH_IMAGE: AUTH_IMAGE || LOCAL_AUTH_IMAGE },
  });
  if (r.status !== 0 && !/taken|exists/i.test(`${r.stdout}${r.stderr}`)) {
    throw new Error(`creating the e2e admin failed: ${r.stderr || r.stdout}`);
  }
}

// ---- backend ---------------------------------------------------------------

function backendEnv() {
  const pg = stack.postgres;
  const mail = stack.catchallMail;
  const env = {
    ...process.env,
    PORT: String(stack.backend.port),
    ENV: 'e2e',
    DBHOST: pg.host,
    DBPORT: String(pg.port),
    DBNAME: pg.database,
    DBUSERNAME: pg.user,
    DBPASSWORD: pg.password,
    DBSSLMODE: 'disable',
    AUTH_JWKS_URL: `${stack.auth.url}/.well-known/jwks.json`,
    AUTH_ISSUER: stack.auth.url,
    AUTH_AUDIENCE: 'boson',
    SKIP_DNS_VERIFY: 'true',
    PURELYMAIL_POP3_HOST: '127.0.0.1',
    PURELYMAIL_POP3_PORT: String(mail.pop3Port),
    PURELYMAIL_POP3_USER: mail.pop3User,
    PURELYMAIL_POP3_PASSWORD: mail.pop3Password,
    PURELYMAIL_POP3_TLS: 'false',
    NICK_CLAIM_EMAIL_DOMAIN: 'boson.chat',
    NICK_CLAIM_RATE_LIMIT_PER_HOUR: '1000',
    CLOUDFLARE_R2_ACCESS_KEY: stack.minio.accessKey,
    CLOUDFLARE_R2_SECRET_KEY: stack.minio.secretKey,
    CLOUDFLARE_R2_ENDPOINT: stack.minio.endpoint,
    CLOUDFLARE_R2_BUCKET: stack.minio.bucket,
    CLOUDFLARE_CDN_BASE_URL: `${stack.minio.endpoint}/${stack.minio.bucket}`,
  };
  delete env.GOCOVERDIR;
  if (coverage) env.GOCOVERDIR = backendCoverDir;
  return env;
}

function buildBackend() {
  mkdirSync(runDir, { recursive: true });
  const tags = coverage ? 'boson_dev,boson_e2ecover' : 'boson_dev';
  // atomic: runtime/coverage.WriteCountersDir (the SIGUSR1 flush) refuses
  // other modes.
  const coverFlags = coverage ? ['-cover', '-covermode=atomic', '-coverpkg=./backend/...'] : [];
  run(GO, ['build', '-tags', tags, ...coverFlags, '-o', backendBin, './backend/cmd/server'], {
    cwd: repoRoot,
    env: { ...process.env, CGO_ENABLED: '0' },
  });
}

function readPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Only signal the PID if it is still OUR binary (PIDs get reused).
export function ourBackendPid() {
  const pid = readPid();
  if (!pid) return null;
  if (process.platform === 'win32') return pid;
  const r = capture('ps', ['-p', String(pid), '-o', 'command=']);
  return r.ok && r.out.includes(backendBin) ? pid : null;
}

async function stopBackend() {
  const pid = ourBackendPid();
  if (pid) {
    log(`stopping backend (pid ${pid})`);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    await waitFor('backend to exit', () => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 10_000).catch(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    });
  }
  rmSync(pidFile, { force: true });
}

function assertNoDevConfig(cwd) {
  for (const rel of ['backend/config/config.dev.json', 'config/config.dev.json', '../config/config.dev.json']) {
    if (existsSync(join(cwd, rel))) throw new Error(`backend would load ${join(cwd, rel)}; refusing to start`);
  }
}

async function startBackend() {
  await stopBackend();
  assertNoDevConfig(runDir);
  const env = backendEnv();
  if (coverage) {
    // Fresh counters per backend start (the migration run's land here too).
    rmSync(backendCoverDir, { recursive: true, force: true });
    mkdirSync(backendCoverDir, { recursive: true });
  }
  log('migrating the e2e database');
  run(backendBin, ['migrate', 'up'], { cwd: runDir, env });
  const out = openSync(logFile, 'w');
  const child = spawn(backendBin, ['serve'], { cwd: runDir, env, detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`);
  log(`backend pid ${child.pid}, log ${logFile}`);
  await waitFor(`backend on ${stack.backend.url}/health`, async () => {
    if (!ourBackendPid()) throw new Error(`backend exited — see ${logFile}`);
    const res = await fetch(`${stack.backend.url}/health`);
    return res.ok;
  }, 30_000).catch((err) => {
    console.error(readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n'));
    throw err;
  });
}

// ---- commands ---------------------------------------------------------------

async function up() {
  const t0 = Date.now();
  composeUp();
  await authUp();
  buildBackend();
  await startBackend();
  log(`up in ${((Date.now() - t0) / 1000).toFixed(1)}s${coverage ? ' (backend coverage build)' : ''}`);
  status();
}

async function down() {
  await stopBackend();
  composeDown();
}

function status() {
  const pid = ourBackendPid();
  console.log([
    `  ergo        ${stack.irc.host}:${stack.irc.port}`,
    `  znc         ${stack.znc.host}:${stack.znc.port}  (${stack.znc.users[0]}..${stack.znc.users.at(-1)} / ${stack.znc.password})`,
    `  postgres    ${stack.postgres.host}:${stack.postgres.port}`,
    `  catch-all   mailpit ${stack.catchallMail.apiUrl}  (smtp :${stack.catchallMail.smtpPort}, pop3 :${stack.catchallMail.pop3Port}; copy ${stack.catchallMail.archiveApiUrl})`,
    `  minio       ${stack.minio.endpoint}`,
    `  auth        ${stack.auth.url}  (users' mailpit ${stack.auth.mailpitUrl}; admin ${stack.auth.admin.username})`,
    `  backend     ${stack.backend.url}  ${pid ? `(pid ${pid})` : '[not running]'}`,
  ].join('\n'));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  const commands = {
    up,
    down,
    status: async () => status(),
    'restart-backend': async () => { buildBackend(); await startBackend(); },
  };
  if (!commands[cmd]) {
    console.error(`usage: e2e-stack.mjs <${Object.keys(commands).join('|')}>`);
    process.exit(2);
  }
  commands[cmd]().catch((err) => {
    console.error(`[e2e-stack] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
