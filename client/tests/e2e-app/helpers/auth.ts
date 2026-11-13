// The e2e stack's boson auth service (github.com/boson-chat/auth), driven
// over its REST API the way the app does — plus the stack's admin account
// (stack.json auth.admin) for lookups and cleanup, and the users' Mailpit
// for verification / reset links.
import { createHash, randomBytes } from 'node:crypto';
import { STACK } from '../stack';
import { Mailpit, extractLinks } from './mailpit';

export interface AuthUser {
  // The auth service's user id (usr_<ULID>): the token's sub, and what the
  // app keys the keychain and scrollback on.
  id: string;
  // The backend's id for this user (users.id): UUIDv5 of `id`
  // (backend/internal/services/authidentity).
  bosonId: string;
  username: string;
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

// A valid, unique auth username (IRC nick rules, ≤ 30 chars).
export function randomUsername(prefix = 'u'): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

// Mirrors authidentity.DerivedUserID in the backend.
const BOSON_ID_NAMESPACE = '7d0c3b8e-4f7a-5b2e-9a61-0b05a0c4a5e1';
export function bosonUserId(authUserId: string): string {
  const ns = Buffer.from(BOSON_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(authUserId).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export async function authApi<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${STACK.auth.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function must<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const r = await authApi<T>(method, path, body, token);
  if (r.status < 200 || r.status >= 300) throw new Error(`auth ${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

let adminToken: { token: string; until: number } | null = null;
async function admin(): Promise<string> {
  if (adminToken && adminToken.until > Date.now()) return adminToken.token;
  const a = STACK.auth.admin;
  const r = await must<{ access_token: string; expires_in: number }>('POST', '/v1/login', { login: a.username, password: a.password });
  adminToken = { token: r.access_token, until: Date.now() + (r.expires_in - 60) * 1000 };
  return r.access_token;
}

// The token from the newest auth-service mail to `email` whose link goes to
// `page` (/verify-email or /reset-password). The link opens the service's
// own page, which posts the token; tests post it directly.
export async function emailToken(email: string, page: '/verify-email' | '/reset-password', mail = Mailpit.users()): Promise<string> {
  const msg = await mail.waitFor({ to: email, subject: page === '/verify-email' ? 'Verify your email' : 'Reset your' });
  const link = extractLinks(msg).find((l) => l.includes(`${page}#token=`));
  if (!link) throw new Error(`no ${page} link in the mail to ${email}:\n${msg.Text}`);
  return link.split('#token=')[1]!;
}

// What clicking the verification link does.
export async function verifyEmail(email: string): Promise<void> {
  await must('POST', '/v1/email/verify', { token: await emailToken(email, '/verify-email') });
}

// A verified user — signs in straight away. (Registration sends the
// verification mail; this consumes it.)
export async function createConfirmedUser(opts: { email?: string; password?: string; username?: string } = {}): Promise<AuthUser> {
  const email = opts.email ?? randomEmail();
  const password = opts.password ?? randomPassword();
  const username = opts.username ?? randomUsername();
  const r = await must<{ user: { id: string } }>('POST', '/v1/register', { username, email, password });
  await verifyEmail(email);
  return { id: r.user.id, bosonId: bosonUserId(r.user.id), username, email, password };
}

// There's no delete: disable (which also revokes every session).
export async function deleteAuthUser(id: string): Promise<void> {
  const r = await authApi('POST', `/v1/admin/users/${id}/disable`, {}, await admin());
  if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new Error(`disable ${id}: ${r.status}`);
}

// A password reset through the real flow: forgot → mail → reset. Like any
// reset it signs out every session, and the identity's password wrap goes
// stale.
export async function setAuthPassword(id: string, password: string): Promise<void> {
  const { user: u } = await must<{ user: { email: string } }>('GET', `/v1/admin/users/${id}`, undefined, await admin());
  const mail = Mailpit.users();
  await mail.clear(`to:"${u.email}" subject:"Reset your"`);
  await must('POST', '/v1/password/forgot', { email: u.email });
  await must('POST', '/v1/password/reset', { token: await emailToken(u.email, '/reset-password', mail), new_password: password });
}

export async function findAuthUserByEmail(email: string): Promise<{ id: string; username: string; email_verified: boolean } | null> {
  const r = await must<{ users: Array<{ id: string; username: string; email: string | null; email_verified: boolean }> }>(
    'GET', `/v1/admin/users?q=${encodeURIComponent(email)}&limit=50`, undefined, await admin(),
  );
  const u = r.users.find((x) => (x.email ?? '').toLowerCase() === email.toLowerCase());
  return u ? { id: u.id, username: u.username, email_verified: u.email_verified } : null;
}

// `login` is a username or an email.
export async function signInWithPassword(login: string, password: string): Promise<AuthSession> {
  const r = await must<{ access_token: string; refresh_token: string; user: { id: string } }>(
    'POST', '/v1/login', { login, password },
  );
  return { accessToken: r.access_token, refreshToken: r.refresh_token, userId: r.user.id };
}
