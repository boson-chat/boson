#!/usr/bin/env node
// The IRC gateway the web build dials under e2e (stack.json web.gateway):
// the stack's webircgateway (boson-chat/stack images/webircgateway: the
// pinned kiwiirc commit + Boson's patches and policy), built natively from
// that pinned stack commit and run on the host, so it reaches everything
// the desktop app does — the compose services' published loopback ports
// and the specs' own loopback proxies (random ports). Private addresses
// and any port ≥ 1024 are allowed here (WEBIRC_ALLOW_PRIVATE, e2e only);
// production keeps IRC ports and public addresses only.
//
//   node scripts/e2e-gateway.mjs up | down | status
//
// Needs go and git. The build is cached under $XDG_CACHE_HOME (or
// ~/.cache)/boson-e2e/webircgateway-<stack commit>.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

// The stack commit whose images/webircgateway is built (the image
// harbor.floret.dev/boson/stack-webircgateway:1.1.0-boson.1).
const STACK_COMMIT = process.env.E2E_GATEWAY_STACK_COMMIT || 'f594ef6';
const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(clientDir, '..');
const stack = JSON.parse(readFileSync(join(repoRoot, 'infra', 'e2e', 'stack.json'), 'utf8'));
const runDir = join(repoRoot, 'infra', 'e2e', '.run');
const pidFile = join(runDir, 'webircgateway.pid');
const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'boson-e2e', `webircgateway-${STACK_COMMIT}`);
const bin = join(cache, 'webircgateway');

function log(m) { console.log(`[e2e-gateway] ${m}`); }

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.signal})`);
}

function build() {
  if (existsSync(bin)) return;
  log(`building from boson-chat/stack@${STACK_COMMIT}`);
  rmSync(cache, { recursive: true, force: true });
  mkdirSync(cache, { recursive: true });
  const stackSrc = join(cache, 'stack');
  run('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', 'https://github.com/boson-chat/stack.git', stackSrc]);
  run('git', ['-C', stackSrc, 'checkout', '-q', STACK_COMMIT, '--', 'images/webircgateway']);
  const img = join(stackSrc, 'images', 'webircgateway');
  const commit = /ARG WEBIRCGATEWAY_COMMIT=([0-9a-f]+)/.exec(readFileSync(join(img, 'Dockerfile'), 'utf8'))?.[1];
  if (!commit) throw new Error('no WEBIRCGATEWAY_COMMIT in the Dockerfile');
  const wig = join(cache, 'wig');
  run('git', ['clone', '-q', 'https://github.com/kiwiirc/webircgateway.git', wig]);
  run('git', ['-C', wig, 'checkout', '-q', commit]);
  for (const p of spawnSync('ls', [join(img, 'patches')], { encoding: 'utf8' }).stdout.split('\n').filter((f) => f.endsWith('.patch'))) {
    run('git', ['-C', wig, 'apply', '--whitespace=nowarn', join(img, 'patches', p)]);
  }
  run('sh', ['-c', `cp "${join(img, 'src')}"/*.go "${join(wig, 'pkg', 'webircgateway')}/"`]);
  run('go', ['build', '-trimpath', '-o', bin, '.'], { cwd: wig, env: { ...process.env, CGO_ENABLED: '0' } });
  // The image's entrypoint renders the config from WEBIRC_*; keep it
  // without its final exec (we run the binary ourselves).
  const entry = readFileSync(join(img, 'entrypoint.sh'), 'utf8').replace(/^exec .*$/m, '');
  writeFileSync(join(cache, 'render-config.sh'), entry);
}

// Any port ≥ 1024, in the policy's ≤1000-port ranges.
function e2ePorts() {
  const out = [];
  for (let lo = 1024; lo <= 65535; lo += 1000) out.push(`${lo}-${Math.min(lo + 999, 65535)}`);
  return out.join(',');
}

function listening(port) {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function running() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

async function up() {
  if (running()) { log('already running'); return; }
  build();
  mkdirSync(runDir, { recursive: true });
  const conf = join(runDir, 'webircgateway.conf');
  const env = {
    ...process.env,
    WEBIRC_CONFIG: conf,
    WEBIRC_ORIGINS: '',
    WEBIRC_TRUSTED_PROXIES: '127.0.0.0/8',
    WEBIRC_ALLOW_PRIVATE: 'true',
    WEBIRC_EXTRA_PORTS: e2ePorts(),
    WEBIRC_MAX_PER_IP: '0',
    WEBIRC_RATE_PER_MIN: '0',
    WEBIRC_THROTTLE: '200',
    WEBIRC_THROTTLE_BURST: '200',
    WEBIRC_PASSWORDS: '',
  };
  // Render the config as the image does, then point it at our port on loopback.
  run('sh', [join(cache, 'render-config.sh')], { env });
  const rendered = readFileSync(conf, 'utf8')
    .replace(/bind = "0\.0\.0\.0"/, 'bind = "127.0.0.1"')
    .replace(/port = 8080/, `port = ${stack.web.gateway.port}`);
  writeFileSync(conf, rendered, { mode: 0o600 });
  const out = openSync(join(runDir, 'webircgateway.log'), 'a');
  const child = spawn(bin, ['-config', conf], { env, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 100; i++) {
    if (await listening(stack.web.gateway.port)) { log(`listening on ${stack.web.gateway.url} (log: infra/e2e/.run/webircgateway.log)`); return; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the gateway did not start; see infra/e2e/.run/webircgateway.log');
}

function down() {
  const pid = running();
  if (pid) { process.kill(pid, 'SIGTERM'); log(`stopped (pid ${pid})`); }
  rmSync(pidFile, { force: true });
}

const cmd = process.argv[2];
const commands = { up, down, status: async () => log(running() ? `running (pid ${running()})` : 'not running') };
if (!commands[cmd]) {
  console.error('usage: e2e-gateway.mjs <up|down|status>');
  process.exit(2);
}
Promise.resolve(commands[cmd]()).catch((err) => { console.error(`[e2e-gateway] ${err.message}`); process.exit(1); });
