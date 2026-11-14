// The e2e stack's Go backend (STACK.backend.url), driven over HTTP the way
// the app does it — bearer token from the auth service — plus fixtures-level
// shortcuts: provision a user's identity (POST /me with a real
// password-wrapped user_secret, built with the app's own crypto). Also the
// e2e network directory (STACK.directory.url, github.com/boson-chat/
// directory with fake DNS): seed verified listings through its /v1 API.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  base64Encode, encryptUserSecret, generateRecoveryCode, generateUserSecret, wrapUserSecret,
} from '../../../src/renderer/src/modules/identity/crypto';
import { E2E_INFRA_DIR, STACK } from '../stack';
import { createConfirmedUser, signInWithPassword, type AuthUser } from './auth';

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

export class BackendApi {
  constructor(private readonly token: string | null = null, readonly baseUrl = STACK.backend.url) {}

  // Signs `user` in against the auth service and returns an API client carrying its
  // access token.
  static async as(user: Pick<AuthUser, 'email' | 'password'>): Promise<BackendApi> {
    const s = await signInWithPassword(user.email, user.password);
    return new BackendApi(s.accessToken);
  }

  static anonymous(): BackendApi {
    return new BackendApi(null);
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* plain-text error body */ }
    return { status: res.status, ok: res.ok, body: parsed as T };
  }

  // Like request(), but throws unless the response is 2xx.
  async must<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.request<T>(method, path, body);
    if (!r.ok) throw new Error(`backend ${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  get<T = unknown>(path: string): Promise<T> { return this.must<T>('GET', path); }
  post<T = unknown>(path: string, body?: unknown): Promise<T> { return this.must<T>('POST', path, body ?? null); }
  put<T = unknown>(path: string, body?: unknown): Promise<T> { return this.must<T>('PUT', path, body ?? null); }
  patch<T = unknown>(path: string, body?: unknown): Promise<T> { return this.must<T>('PATCH', path, body ?? null); }
  delete<T = unknown>(path: string): Promise<T> { return this.must<T>('DELETE', path); }
}

// Handles: 3+ chars, alphanumeric + underscore (what the setup prompt asks
// for), unique per call.
export function randomHandle(prefix = 'e2e'): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

export interface ProvisionedIdentity {
  handle: string;
  recoveryCode: string;
}

// What the app's SetupPrompt does after the first sign-in, minus the UI:
// generate a user_secret, wrap it under the password (+ a recovery code)
// with the app's crypto, POST /me. Signing in afterwards in the UI unlocks
// the identity with the password and lands straight in the directory.
export async function provisionIdentity(
  user: Pick<AuthUser, 'email' | 'password'>,
  handle = randomHandle(),
): Promise<ProvisionedIdentity> {
  const secret = generateUserSecret();
  const recoveryCode = generateRecoveryCode();
  const [blob, recoveryBlob] = await Promise.all([
    encryptUserSecret(secret, user.password),
    wrapUserSecret(secret, recoveryCode),
  ]);
  const api = await BackendApi.as(user);
  await api.post('/me', {
    handle,
    encrypted_user_secret: base64Encode(blob),
    encrypted_user_secret_recovery: base64Encode(recoveryBlob),
  });
  return { handle, recoveryCode };
}

// A listing as the directory's /v1 API returns it (the fields the specs use).
export interface DirectoryServer {
  id: string;
  hostname: string;
  port: number;
  tls: boolean;
  name: string;
  description?: string | null;
  status: string;
  verification_status: string;
  verification_token?: string;
  owner?: { kind: string; auth_user_id?: string };
}

export interface SeedServerInput {
  name?: string;
  hostname?: string;
  port?: number;
  tls?: boolean;
  description?: string;
  tags?: string[];
  languages?: string[];
  isNsfw?: boolean;
}

// The e2e directory's /v1 API (same client, other base URL).
export function directoryApi(token: string | null = null): BackendApi {
  return new BackendApi(token, STACK.directory.url);
}

export async function directoryApiAs(user: Pick<AuthUser, 'email' | 'password'>): Promise<BackendApi> {
  const s = await signInWithPassword(user.email, user.password);
  return directoryApi(s.accessToken);
}

// The account that owns seeded listings: one per test process, created
// lazily. The directory keys owners by their auth-service account, so it
// needs no boson identity.
let operator: Promise<BackendApi> | null = null;
function directoryOperator(): Promise<BackendApi> {
  operator ??= (async () => directoryApiAs(await createConfirmedUser()))();
  return operator;
}

// A hostname only this listing uses (the directory lists each hostname once)
// that still reaches the e2e ergo: *.localhost resolves to loopback.
export function seededHostname(prefix = 'e2e'): string {
  return `${prefix}-${randomBytes(5).toString('hex')}.localhost`;
}

// Registers a listing through the directory's API and verifies it (fake
// DNS: verification needs no TXT record); only verified listings are
// browsable. Defaults to the e2e ergo over plain TCP on a unique
// *.localhost hostname and a unique name.
export async function seedServer(input: SeedServerInput = {}): Promise<DirectoryServer> {
  const api = await directoryOperator();
  const created = await api.post<{ network: DirectoryServer }>('/v1/networks', {
    hostname: input.hostname ?? seededHostname(),
    port: input.port ?? STACK.irc.port,
    tls: input.tls ?? false,
    name: input.name ?? `E2E Seeded ${randomBytes(3).toString('hex')}`,
    description: input.description,
    tags: input.tags ?? ['e2e'],
    languages: input.languages ?? ['en'],
    is_nsfw: input.isNsfw ?? false,
  });
  const verified = await api.post<{ network: DirectoryServer; success: boolean }>(`/v1/networks/${created.network.id}/verify`);
  if (!verified.success || verified.network.status !== 'verified') {
    throw new Error(`seeded listing ${created.network.id} did not verify: ${JSON.stringify(verified)}`);
  }
  return verified.network;
}

// Runs SQL against the directory's e2e Postgres, for listing state only its
// workers set (health, user counts, lapses). Returns psql's tuples-only output.
export function directorySql(sql: string): string {
  const d = STACK.directory;
  return psql('directory-postgres', d.user, d.database, sql);
}

// Runs SQL against the backend's e2e Postgres (psql inside the compose
// container — no Node driver needed). For state the API can't reach; prefer
// the API. Returns psql's unaligned, tuples-only output.
export function backendSql(sql: string): string {
  const pg = STACK.postgres;
  return psql('postgres', pg.user, pg.database, sql);
}

function psql(service: string, user: string, database: string, sql: string): string {
  const r = spawnSync('docker', [
    'compose', '-f', join(E2E_INFRA_DIR, 'docker-compose.yml'), 'exec', '-T', service,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, '-At', '-c', sql,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.error?.message}`);
  return r.stdout.trim();
}
