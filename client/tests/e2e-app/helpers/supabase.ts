// Supabase Auth (GoTrue) of the e2e stack, driven over HTTP — the admin API
// with the project's secret (service_role) key, and the public password
// grant. Everything goes through Kong at STACK.supabase.apiUrl, exactly like
// the app.
import { randomBytes } from 'node:crypto';
import { STACK } from '../stack';

export interface AuthUser {
  id: string;
  email: string;
  password: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

// Unique per call, so concurrent tests / workers / runs never collide.
export function randomEmail(prefix = 'e2e'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.test`;
}

export function randomPassword(): string {
  return `pw-${randomBytes(9).toString('base64url')}`;
}

async function gotrue<T>(path: string, init: RequestInit & { admin?: boolean } = {}): Promise<T> {
  const key = init.admin ? STACK.supabase.secretKey : STACK.supabase.publishableKey;
  const res = await fetch(`${STACK.supabase.apiUrl}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      ...(init.admin ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`supabase ${init.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

// A confirmed (email_confirmed_at set) user — signs in straight away, no
// confirmation mail.
export async function createConfirmedUser(opts: { email?: string; password?: string } = {}): Promise<AuthUser> {
  const email = opts.email ?? randomEmail();
  const password = opts.password ?? randomPassword();
  const u = await gotrue<{ id: string }>('/admin/users', {
    method: 'POST',
    admin: true,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  return { id: u.id, email, password };
}

export async function deleteAuthUser(id: string): Promise<void> {
  await gotrue(`/admin/users/${id}`, { method: 'DELETE', admin: true }).catch((err: unknown) => {
    if (!String(err).includes(': 404')) throw err;
  });
}

export async function findAuthUserByEmail(email: string): Promise<{ id: string; email_confirmed_at: string | null } | null> {
  // The local admin API has no email filter; the e2e project only ever holds
  // test users, so a page of 1000 is plenty.
  const r = await gotrue<{ users: Array<{ id: string; email: string; email_confirmed_at?: string | null }> }>(
    '/admin/users?per_page=1000', { admin: true },
  );
  const u = r.users.find((x) => x.email === email);
  // GoTrue omits email_confirmed_at until the address is confirmed.
  return u ? { id: u.id, email_confirmed_at: u.email_confirmed_at ?? null } : null;
}

export async function signInWithPassword(email: string, password: string): Promise<AuthSession> {
  const r = await gotrue<{ access_token: string; refresh_token: string; user: { id: string } }>(
    '/token?grant_type=password',
    { method: 'POST', body: JSON.stringify({ email, password }) },
  );
  return { accessToken: r.access_token, refreshToken: r.refresh_token, userId: r.user.id };
}
