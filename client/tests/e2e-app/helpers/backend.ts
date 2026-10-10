// The e2e stack's Go backend (STACK.backend.url), driven over HTTP the way
// the app does it — bearer token from Supabase — plus fixtures-level
// shortcuts: provision a user's identity (POST /me with a real
// password-wrapped user_secret, built with the app's own crypto), and seed
// verified directory servers.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  base64Encode, encryptUserSecret, generateRecoveryCode, generateUserSecret, wrapUserSecret,
} from '../../../src/renderer/src/modules/identity/crypto';
import { E2E_INFRA_DIR, STACK } from '../stack';
import { createConfirmedUser, signInWithPassword, type AuthUser } from './supabase';

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

export class BackendApi {
  constructor(private readonly token: string | null = null, readonly baseUrl = STACK.backend.url) {}

  // Signs `user` in against Supabase and returns an API client carrying its
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

export interface DirectoryServer {
  id: string;
  hostname: string;
  port: number;
  tls: boolean;
  name: string;
  description?: string | null;
  verification_status: string;
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

// The account that "owns" seeded servers: one per test process, provisioned
// lazily (servers.registered_by must reference a users row).
let operator: Promise<BackendApi> | null = null;
function directoryOperator(): Promise<BackendApi> {
  operator ??= (async () => {
    const user = await createConfirmedUser();
    await provisionIdentity(user, randomHandle('operator'));
    return BackendApi.as(user);
  })();
  return operator;
}

// Registers a server through the real API and verifies it (the e2e backend
// is a boson_dev build with SKIP_DNS_VERIFY, so verification needs no TXT
// record) — only verified servers are listed in the public directory.
// Defaults to the e2e ergo over plain TCP and a unique name.
//
// The directory is shared by every test and run, and the app hides a
// manually added server when the directory lists the same hostname:port.
// So seeded servers default to the ergo as `localhost`, while guest specs
// add it by hand as 127.0.0.1 (IRC_HOST) — keep it that way.
export const SEEDED_IRC_HOST = 'localhost';
export async function seedServer(input: SeedServerInput = {}): Promise<DirectoryServer> {
  const api = await directoryOperator();
  const created = await api.post<DirectoryServer>('/servers', {
    hostname: input.hostname ?? SEEDED_IRC_HOST,
    port: input.port ?? STACK.irc.port,
    tls: input.tls ?? false,
    name: input.name ?? `E2E Seeded ${randomBytes(3).toString('hex')}`,
    description: input.description,
    tags: input.tags ?? ['e2e'],
    languages: input.languages ?? ['en'],
    is_nsfw: input.isNsfw ?? false,
  });
  const verified = await api.post<{ server: DirectoryServer; success: boolean }>(`/servers/${created.id}/verify`);
  if (!verified.success || verified.server.verification_status !== 'verified') {
    throw new Error(`seeded server ${created.id} did not verify: ${JSON.stringify(verified)}`);
  }
  return verified.server;
}

// Runs SQL against the backend's e2e Postgres (psql inside the compose
// container — no Node driver needed). For state the API can't reach; prefer
// the API. Returns psql's unaligned, tuples-only output.
export function backendSql(sql: string): string {
  const pg = STACK.postgres;
  const r = spawnSync('docker', [
    'compose', '-f', join(E2E_INFRA_DIR, 'docker-compose.yml'), 'exec', '-T', 'postgres',
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', pg.user, '-d', pg.database, '-At', '-c', sql,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr || r.error?.message}`);
  return r.stdout.trim();
}
