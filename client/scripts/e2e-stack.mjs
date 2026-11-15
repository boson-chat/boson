#!/usr/bin/env node
// Brings the real-app e2e stack up / down (client/tests/e2e-app/):
//
//   node scripts/e2e-stack.mjs up       # compose (incl. auth service, backend + its migrations)
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
//      the boson auth service with its Postgres and the users' Mailpit, and
//      the network directory (github.com/boson-chat/directory, fake DNS) with
//      its Postgres; and a self-hosted network (auth2 + ergo2: a second auth
//      service and the boson stack's Ergo) for the network sign-in specs.
//      The auth image is built from $AUTH_SRC (default: an `auth` checkout
//      next to this repo) unless $AUTH_IMAGE names one to use. `up` creates
//      the stack's admin account (stack.json auth.admin) for the tests.
//   2. The boson backend (github.com/boson-chat/backend) from its image
//      ($BACKEND_IMAGE, default pinned in the compose file): `migrate up`
//      as the one-shot `backend-migrate`, then `serve` as `backend`, once
//      the auth service is ready. Env-only config, set in the compose file.
//      Its log: `docker compose -f infra/e2e/docker-compose.yml logs backend`.
//
// `down` only ever stops what this script started: the compose project
// `boson-e2e`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(clientDir, '..');
const e2eDir = join(repoRoot, 'infra', 'e2e');
const stack = JSON.parse(readFileSync(join(e2eDir, 'stack.json'), 'utf8'));

const AUTH_IMAGE = process.env.AUTH_IMAGE ?? '';
const AUTH_SRC = process.env.AUTH_SRC ?? join(repoRoot, '..', 'auth');
const LOCAL_AUTH_IMAGE = 'boson-e2e-auth:local';
const BACKEND_IMAGE = process.env.BACKEND_IMAGE ?? '';

const compose = ['compose', '-f', join(e2eDir, 'docker-compose.yml')];
const COMPOSE_SERVICES = [
  'ergo', 'znc', 'postgres', 'mailpit-archive', 'mailpit', 'minio', 'auth-postgres', 'auth-mailpit', 'auth',
  'directory-postgres', 'directory',
  // A self-hosted network: its own auth service and Ergo (network-signin.spec.ts).
  'auth2-postgres', 'auth2', 'ergo2',
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

function composeEnv() {
  return { ...process.env, AUTH_IMAGE: AUTH_IMAGE || LOCAL_AUTH_IMAGE };
}

function composeUp() {
  prepareAuthImage();
  run('docker', [...compose, 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', ...COMPOSE_SERVICES], {
    env: composeEnv(),
  });
  // One-shot bucket setup (loops until MinIO answers, then exits).
  run('docker', [...compose, 'run', '--rm', '--build', 'minio-setup']);
}

function composeDown() {
  run('docker', [...compose, 'down', '-v', '--remove-orphans'], { env: composeEnv() });
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
  const auth2 = stack.selfhost.auth;
  await waitFor(`self-hosted network's auth service on ${auth2.url}/readyz`, async () => (await fetch(`${auth2.url}/readyz`)).ok, 60_000);
  // The tests' admin account (looks users up, disables them afterwards).
  // `user create` marks the email verified; rerunning on a live stack finds
  // it taken, which is fine.
  const r = spawnSync('docker', [...compose, 'exec', '-T', 'auth', './auth', 'user', 'create',
    '--username', auth.admin.username, '--email', auth.admin.email, '--role', 'admin', '--password-stdin'], {
    input: `${auth.admin.password}\n`, encoding: 'utf8', env: composeEnv(),
  });
  if (r.status !== 0 && !/taken|exists/i.test(`${r.stdout}${r.stderr}`)) {
    throw new Error(`creating the e2e admin failed: ${r.stderr || r.stdout}`);
  }
}

// ---- network directory -----------------------------------------------------

// The directory (github.com/boson-chat/directory) runs from its image with
// fake DNS; it migrates its database at start.
async function directoryUp() {
  const dir = stack.directory;
  await waitFor(`directory on ${dir.url}`, async () => (await fetch(`${dir.url}/.well-known/boson-directory.json`)).ok, 60_000);
}

// ---- backend ---------------------------------------------------------------

// The backend (github.com/boson-chat/backend) runs from its image as the
// compose services `backend-migrate` (one-shot `migrate up`) and `backend`
// (`serve`), started once the auth service answers. $BACKEND_IMAGE overrides
// the image (default: the pinned release in docker-compose.yml).
async function startBackend() {
  if (BACKEND_IMAGE && !capture('docker', ['image', 'inspect', BACKEND_IMAGE]).ok) run('docker', ['pull', BACKEND_IMAGE]);
  log('migrating the e2e database and starting the backend');
  // --no-deps: the rest of the stack is up already (and restart-backend must
  // leave it alone).
  run('docker', [...compose, 'run', '--rm', '--no-deps', 'backend-migrate'], { env: composeEnv() });
  run('docker', [...compose, 'up', '-d', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '60', 'backend'], {
    env: composeEnv(),
  });
  await waitFor(`backend on ${stack.backend.url}/health`, async () => {
    const res = await fetch(`${stack.backend.url}/health`);
    return res.ok;
  }, 30_000).catch((err) => {
    run('docker', [...compose, 'logs', '--no-color', '--tail', '30', 'backend'], { env: composeEnv() });
    throw err;
  });
}

function backendRunning() {
  const r = capture('docker', [...compose, 'ps', '--status', 'running', '-q', 'backend'], { env: composeEnv() });
  return r.ok && r.out.trim() !== '';
}

// ---- commands ---------------------------------------------------------------

async function up() {
  const t0 = Date.now();
  composeUp();
  await authUp();
  await directoryUp();
  await startBackend();
  log(`up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  status();
}

async function down() {
  composeDown();
}

function status() {
  const running = backendRunning();
  console.log([
    `  ergo        ${stack.irc.host}:${stack.irc.port}`,
    `  znc         ${stack.znc.host}:${stack.znc.port}  (${stack.znc.users[0]}..${stack.znc.users.at(-1)} / ${stack.znc.password})`,
    `  postgres    ${stack.postgres.host}:${stack.postgres.port}`,
    `  catch-all   mailpit ${stack.catchallMail.apiUrl}  (smtp :${stack.catchallMail.smtpPort}, pop3 :${stack.catchallMail.pop3Port}; copy ${stack.catchallMail.archiveApiUrl})`,
    `  minio       ${stack.minio.endpoint}`,
    `  auth        ${stack.auth.url}  (users' mailpit ${stack.auth.mailpitUrl}; admin ${stack.auth.admin.username})`,
    `  directory   ${stack.directory.url}  (db :${stack.directory.dbPort})`,
    `  selfhost    irc ${stack.selfhost.irc.host}:${stack.selfhost.irc.port}, auth ${stack.selfhost.auth.url}  (a second network: own accounts, no guests)`,
    `  backend     ${stack.backend.url}  ${running ? `(${BACKEND_IMAGE || 'pinned image'})` : '[not running]'}`,
  ].join('\n'));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  const commands = {
    up,
    down,
    status: async () => status(),
    'restart-backend': startBackend,
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
