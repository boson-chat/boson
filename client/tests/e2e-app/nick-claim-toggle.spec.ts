// Nick claims are a per-network switch (off by default). The e2e stack's
// api runs with them on (NICK_CLAIM_ENABLED=true, inbound = the catch-all
// Mailpit); this spec checks that, then starts a second api from the same
// binary with them off (the self-hosted default) and drives the stack
// config file (BOSON_CONFIG) to turn them on and off live: GET /config,
// the 403 on POST /me/nick-claims, existing claims staying readable, and
// the internal status/test endpoints the admin panel uses.
//
// A second container instead of flipping the shared one: other specs claim
// nicks in parallel against the shared api. It runs the shared api's image
// on the stack's compose network (so it reaches Postgres, auth and Mailpit
// by their service names), with the config file's directory mounted in.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, randomNick, uid } from './fixtures';
import { signInWithPassword } from './helpers/auth';
import { E2E_INFRA_DIR, STACK } from './stack';

const TOKEN = STACK.backend.internalToken;

// The shared api's container: its image and compose network.
function sharedBackend(): { image: string; network: string } {
  const ps = spawnSync('docker', ['compose', '-f', join(E2E_INFRA_DIR, 'docker-compose.yml'), 'ps', '-q', 'backend'], { encoding: 'utf8' });
  const id = ps.stdout.trim().split('\n')[0];
  if (ps.status !== 0 || !id) throw new Error(`no e2e backend container: ${ps.stderr}`);
  const inspect = spawnSync('docker', ['inspect', '--format', '{{.Config.Image}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}', id], { encoding: 'utf8' });
  const [image, network] = inspect.stdout.trim().split('|');
  if (inspect.status !== 0 || !image || !network) throw new Error(`docker inspect ${id} failed: ${inspect.stderr}`);
  return { image, network };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

async function json<T = unknown>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const internal = (base: string, path: string, init: RequestInit = {}) =>
  json<Record<string, any>>(`${base}${path}`, { ...init, headers: { 'X-Internal-Token': TOKEN, ...(init.headers ?? {}) } });

// writeAtomic writes like the admin panel: tmp file + rename in the same dir.
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${uid()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// Inside the compose network: the catch-all Mailpit's service name and port.
const MAILPIT_POP3 = { host: 'mailpit', port: 1110 };

const mailpitInbound = `  inbound:
    protocol: pop3
    host: ${MAILPIT_POP3.host}
    port: ${MAILPIT_POP3.port}
    tls: false
    user: ${STACK.catchallMail.pop3User}
`;

test('nick claims: on in the e2e stack; off by default elsewhere, and the config file turns them on and off live', async ({ account }) => {
  test.setTimeout(90_000);

  // ---- the shared e2e api: on ----
  expect((await json(`${STACK.backend.url}/config`)).body).toEqual({ nick_claim: true });
  const shared = await internal(STACK.backend.internalUrl, '/internal/nick-claims/status');
  expect(shared.status).toBe(200);
  expect(shared.body).toMatchObject({
    enabled: true,
    email_domain: 'boson.chat',
    inbound: { host: MAILPIT_POP3.host, port: MAILPIT_POP3.port, tls: false, user: STACK.catchallMail.pop3User, password_set: true },
    worker: { running: true },
  });
  // Whether a password is set, never the password itself.
  expect(JSON.stringify(shared.body)).not.toContain('"password"');
  expect((await json(`${STACK.backend.internalUrl}/internal/nick-claims/status`)).status).toBe(401);
  // The connection test, against the real Mailpit POP3.
  const probe = await internal(STACK.backend.internalUrl, '/internal/nick-claims/test', { method: 'POST' });
  expect(probe.body).toMatchObject({ ok: true });
  const cfgStatus = await json<Record<string, any>>(`${STACK.backend.internalUrl}/internal/config/status`);
  expect(cfgStatus.body.nick_claim).toMatchObject({ enabled: true, worker: 'running' });

  // A claim minted while on (read back through the second api below).
  const { accessToken } = await signInWithPassword(account.email, account.password);
  const auth = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const minted = await json<{ id: string; email: string }>(`${STACK.backend.url}/me/nick-claims`, {
    method: 'POST', headers: auth, body: JSON.stringify({ server_id: `toggle-${uid()}`, account_nick: randomNick('tg') }),
  });
  expect(minted.status).toBe(201);
  expect(minted.body.email).toMatch(/^reg\+[a-f0-9]{32}-[a-z0-9]{8}@boson\.chat$/);

  // ---- a second api with the self-hosted defaults: off ----
  const dir = mkdtempSync(join(tmpdir(), 'boson-e2e-nickclaim-'));
  // The image runs as a non-root user: let it read (and watch) the mount.
  chmodSync(dir, 0o755);
  const containerDir = '/etc/boson-e2e';
  const configPath = join(dir, 'boson.yaml');
  writeFileSync(configPath, 'version: 1\n', { mode: 0o644 });
  const [port, internalPort] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${port}`;
  const internalBase = `http://127.0.0.1:${internalPort}`;
  const { image, network } = sharedBackend();
  const name = `boson-e2e-nickclaim-${uid()}`;
  const env: Record<string, string> = {
    ENV: 'e2e',
    DBHOST: 'postgres', DBPORT: '5432', DBNAME: STACK.postgres.database, DBUSERNAME: STACK.postgres.user,
    DBPASSWORD: STACK.postgres.password, DBSSLMODE: 'disable',
    AUTH_JWKS_URL: 'http://auth:8080/.well-known/jwks.json', AUTH_ISSUER: STACK.auth.url, AUTH_AUDIENCE: 'boson',
    INTERNAL_ADDR: ':3001', INTERNAL_TOKEN: TOKEN,
    BOSON_CONFIG: `${containerDir}/boson.yaml`,
    // Only the password comes from env; the old names alone don't enable it.
    PURELYMAIL_POP3_PASSWORD: STACK.catchallMail.pop3Password,
    NICK_CLAIM_EMAIL_DOMAIN: 'boson.chat',
  };
  let child: ChildProcess | null = null;
  let logs = '';
  try {
    child = spawn('docker', [
      'run', '--rm', '--name', name, '--network', network,
      '-p', `127.0.0.1:${port}:3000`, '-p', `127.0.0.1:${internalPort}:3001`,
      '-v', `${dir}:${containerDir}`,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      image, 'serve',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (b) => { logs += String(b); });
    child.stderr?.on('data', (b) => { logs += String(b); });
    await expect.poll(async () => {
      try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
    }, { timeout: 30_000, message: 'second api /health' }).toBe(true);

    expect((await json(`${base}/config`)).body).toEqual({ nick_claim: false });
    const denied = await json(`${base}/me/nick-claims`, {
      method: 'POST', headers: auth, body: JSON.stringify({ server_id: 'x', account_nick: 'y' }),
    });
    expect(denied).toEqual({ status: 403, body: { error: 'nick_claim_disabled' } });
    // Existing claims stay readable.
    const read = await json<{ status: string }>(`${base}/me/nick-claims/${minted.body.id}`, { headers: auth });
    expect(read.status).toBe(200);
    expect(['pending', 'captured', 'consumed', 'expired']).toContain(read.body.status);
    const off = await internal(internalBase, '/internal/nick-claims/status');
    expect(off.body).toMatchObject({ enabled: false, worker: { running: false } });
    expect((await json<Record<string, any>>(`${internalBase}/internal/config/status`)).body)
      .toMatchObject({ ok: true, path: `${containerDir}/boson.yaml`, nick_claim: { enabled: false, worker: 'stopped' } });

    // ---- the admin enables it in the config file: live ----
    writeAtomic(configPath, `version: 1\nnick_claim:\n  enabled: true\n  email_domain: boson.chat\n${mailpitInbound}`);
    await expect.poll(async () => (await json<{ nick_claim: boolean }>(`${base}/config`)).body.nick_claim, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await internal(internalBase, '/internal/nick-claims/status')).body.worker?.last_ok_at ?? null,
      { timeout: 20_000, message: 'worker drained Mailpit' }).not.toBeNull();

    // A broken edit keeps the last good config and reports where.
    writeAtomic(configPath, 'version: 1\nnick_claim:\n  enabled: [oops\n');
    await expect.poll(async () => (await json<Record<string, any>>(`${internalBase}/internal/config/status`)).body.ok, { timeout: 20_000 }).toBe(false);
    expect((await json(`${base}/config`)).body).toEqual({ nick_claim: true });

    // ...and turning it off stops the worker.
    writeAtomic(configPath, 'version: 1\nnick_claim:\n  enabled: false\n');
    await expect.poll(async () => (await json<{ nick_claim: boolean }>(`${base}/config`)).body.nick_claim, { timeout: 20_000 }).toBe(false);
    await expect.poll(async () => (await internal(internalBase, '/internal/nick-claims/status')).body.worker?.running, { timeout: 20_000 }).toBe(false);
    const again = await json(`${base}/me/nick-claims`, {
      method: 'POST', headers: auth, body: JSON.stringify({ server_id: 'x', account_nick: 'y' }),
    });
    expect(again.status).toBe(403);
  } catch (err) {
    console.error(`second api log:\n${logs.split('\n').slice(-40).join('\n')}`);
    throw err;
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    child?.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});
