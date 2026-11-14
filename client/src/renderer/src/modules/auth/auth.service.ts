// Client for the boson auth service (github.com/boson-chat/auth): sign-up,
// email verification, password sign-in, rotating refresh tokens, password
// reset and sign-out, over its REST API.
//
// Tokens: the access token (EdDSA JWT, 15 min) lives in memory only and is
// what the Boson API gets as `Authorization: Bearer`. The refresh token is
// opaque, rotates on every use and — if an old one is ever presented again —
// the auth service revokes the whole session. So refreshes are single-flight
// (one request in the air, everyone else awaits it), and the newest refresh
// token is written to the OS keychain (SecureStorage), never localStorage.
//
// Requests go through the desktop shell's API proxy when it's there (the
// webview origin isn't one the auth service CORS-allows), else plain fetch.

import { type ApiTransport, defaultApiTransport } from '../../shared/http/transport';
import type { SecureStorage } from '../../shared/secure-storage';

export interface AuthUser {
  // The auth service's user id (usr_<ULID>), the token's `sub`.
  id: string;
  // Account username; an IRC nick. Distinct from the Boson handle.
  username: string;
  email: string | null;
  email_verified: boolean;
  role: 'user' | 'admin' | string;
  // Renderer-side cache of profile fields (handle, avatar_url) so the title
  // bar updates the moment settings change them. Not stored by the auth
  // service; the Boson API (/me) is the source of truth.
  user_metadata: Record<string, unknown>;
}

export interface Session {
  // '' until the first refresh after a restore from storage.
  access_token: string;
  // Access-token expiry, ms since the epoch.
  expires_at: number;
  refresh_token: string;
  session_id: string;
  user: AuthUser;
}

export interface AuthState {
  session: Session | null;
  loading: boolean;
  error: string | null;
}

export type AuthListener = (state: AuthState) => void;

// A quicvoiced token (POST /v1/voice/token).
export interface VoiceToken {
  token: string;
  // ms since the epoch.
  expiresAt: number;
}

export interface SignUpInput {
  username: string;
  email: string;
  password: string;
}

export interface SignUpResult {
  // The account exists but can't sign in until the emailed link is opened.
  verificationRequired: boolean;
}

// An error from the auth service: `code` is its machine-readable error
// (invalid_credentials, email_not_verified, username_taken, …), or
// 'network' when it couldn't be reached.
export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  session_id: string;
  user: Omit<AuthUser, 'user_metadata'>;
}

export interface AuthServiceOptions {
  storage?: SecureStorage;
  transport?: ApiTransport;
  now?: () => number;
}

// Refresh this long before the access token expires.
const EXPIRY_SKEW_MS = 60_000;

export class AuthService {
  static readonly STORAGE_KEY = 'boson.auth.session';

  private readonly baseUrl: string;
  private readonly storage: SecureStorage | null;
  private readonly transport: ApiTransport;
  private readonly now: () => number;
  private state: AuthState = { session: null, loading: true, error: null };
  private readonly listeners = new Set<AuthListener>();
  private refreshing: Promise<Session | null> | null = null;
  // Bumped on sign-in / sign-out so a refresh that was in flight when the
  // session changed can't resurrect the old one.
  private epoch = 0;

  constructor(baseUrl: string, opts: AuthServiceOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.storage = opts.storage ?? null;
    this.transport = opts.transport ?? defaultApiTransport();
    this.now = opts.now ?? Date.now;
  }

  // Restore the saved session, if any, and trade its refresh token for a
  // fresh access token. Offline at launch → keep the session (the app can
  // still unlock from the keychain); getToken() retries later.
  async init(): Promise<void> {
    const saved = await this.loadSaved();
    if (!saved) {
      this.setState({ session: null, loading: false, error: null });
      return;
    }
    this.state = { ...this.state, session: saved };
    try {
      await this.refresh();
    } catch (err) {
      console.warn('[auth] refresh at startup failed; keeping the saved session', err);
    }
    this.setState({ session: this.state.session, loading: false, error: null });
  }

  markFatal(message: string): void {
    this.setState({ ...this.state, loading: false, error: message });
  }

  // `login` is a username or an email address.
  async signIn(login: string, password: string): Promise<void> {
    const r = await this.call<TokenResponse>('POST', '/v1/login', { login: login.trim(), password });
    this.epoch++;
    const session = this.toSession(r, {});
    await this.save(session);
    this.setState({ session, loading: false, error: null });
  }

  async signUp(input: SignUpInput): Promise<SignUpResult> {
    const r = await this.call<{ email_verification_required: boolean }>('POST', '/v1/register', {
      username: input.username.trim(),
      email: input.email.trim(),
      password: input.password,
    });
    if (r.email_verification_required) return { verificationRequired: true };
    await this.signIn(input.username, input.password);
    return { verificationRequired: false };
  }

  // Same 202 whether or not the account exists.
  async resendVerification(email: string): Promise<void> {
    await this.call('POST', '/v1/email/resend', { email: email.trim() });
  }

  // Emails a reset link (to the auth service's /reset-password page). Same
  // 202 whether or not the account exists.
  async requestPasswordReset(email: string): Promise<void> {
    await this.call('POST', '/v1/password/forgot', { email: email.trim() });
  }

  async signOut(): Promise<void> {
    const refreshToken = this.state.session?.refresh_token;
    this.epoch++;
    await this.clearSaved();
    this.setState({ session: null, loading: false, error: null });
    if (refreshToken) {
      // Revoke server-side; best-effort (offline sign-out still forgets
      // the session locally).
      try {
        await this.call('POST', '/v1/logout', { refresh_token: refreshToken });
      } catch (err) {
        console.warn('[auth] logout request failed', err);
      }
    }
  }

  // Merge profile fields into the session's user_metadata cache.
  async updateMetadata(data: Record<string, unknown>): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    const session = { ...s, user: { ...s.user, user_metadata: { ...s.user.user_metadata, ...data } } };
    this.setState({ ...this.state, session });
    await this.save(session);
  }

  // A valid access token for the Boson API, refreshing first if it's
  // missing or about to expire. null when signed out or unreachable.
  async getToken(): Promise<string | null> {
    const s = this.state.session;
    if (!s) return null;
    if (s.access_token && s.expires_at - EXPIRY_SKEW_MS > this.now()) return s.access_token;
    try {
      return (await this.refresh())?.access_token ?? null;
    } catch {
      return null;
    }
  }

  // The API answered 401 to `rejected`: refresh (unless someone already
  // did) and hand back the token to retry with.
  async tokenRejected(rejected: string): Promise<string | null> {
    const s = this.state.session;
    if (!s) return null;
    if (s.access_token && s.access_token !== rejected && s.expires_at - EXPIRY_SKEW_MS > this.now()) {
      return s.access_token;
    }
    try {
      return (await this.refresh())?.access_token ?? null;
    } catch {
      return null;
    }
  }

  // A voice token for quicvoiced (POST /v1/voice/token): 5 minutes, audience
  // "quicvoice", limited to `rooms` when given. Throws AuthError — code
  // 'signed_out' without a session.
  async voiceToken(rooms?: string[]): Promise<VoiceToken> {
    const body = rooms && rooms.length > 0 ? { rooms } : {};
    let token = await this.getToken();
    if (!token) throw new AuthError('signed_out', 'Sign in to use voice.', 401);
    try {
      return await this.voiceTokenWith(token, body);
    } catch (err) {
      if (!(err instanceof AuthError) || err.status !== 401) throw err;
      token = await this.tokenRejected(token);
      if (!token) throw new AuthError('signed_out', 'Sign in to use voice.', 401);
      return this.voiceTokenWith(token, body);
    }
  }

  private async voiceTokenWith(accessToken: string, body: unknown): Promise<VoiceToken> {
    const r = await this.call<{ token?: string; expires_in?: number }>('POST', '/v1/voice/token', body, accessToken);
    if (!r?.token) throw new AuthError('invalid_response', 'The sign-in service sent no voice token.', 200);
    return { token: r.token, expiresAt: this.now() + (r.expires_in ?? 300) * 1000 };
  }

  // Single-flight refresh. Resolves null (and signs out locally) when the
  // auth service rejects the refresh token; throws on network errors.
  refresh(): Promise<Session | null> {
    if (this.refreshing) return this.refreshing;
    const current = this.state.session;
    if (!current) return Promise.resolve(null);
    const epoch = this.epoch;
    this.refreshing = (async () => {
      try {
        const r = await this.call<TokenResponse>('POST', '/v1/token/refresh', { refresh_token: current.refresh_token });
        if (epoch !== this.epoch) return this.state.session;
        const session = this.toSession(r, current.user.user_metadata);
        await this.save(session);
        this.setState({ ...this.state, session });
        return session;
      } catch (err) {
        if (err instanceof AuthError && err.status === 401 && epoch === this.epoch) {
          // Expired, revoked or reused: the session is over.
          this.epoch++;
          await this.clearSaved();
          this.setState({ session: null, loading: false, error: null });
          return null;
        }
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  getState(): AuthState {
    return this.state;
  }

  subscribe(fn: AuthListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  private toSession(r: TokenResponse, metadata: Record<string, unknown>): Session {
    return {
      access_token: r.access_token,
      expires_at: this.now() + r.expires_in * 1000,
      refresh_token: r.refresh_token,
      session_id: r.session_id,
      user: { ...r.user, user_metadata: metadata },
    };
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown, bearer?: string): Promise<T> {
    let res;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    try {
      res = await this.transport({
        method,
        url: `${this.baseUrl}${path}`,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      });
    } catch (err) {
      throw new AuthError('network', `Couldn't reach the sign-in service (${err instanceof Error ? err.message : String(err)}).`, 0);
    }
    if (res.status === 0) {
      throw new AuthError('network', `Couldn't reach the sign-in service (${res.statusText || 'no response'}).`, 0);
    }
    let parsed: unknown = null;
    if (res.text) {
      try { parsed = JSON.parse(res.text); } catch { parsed = null; }
    }
    if (!res.ok) {
      const p = (parsed ?? {}) as { error?: string; message?: string; retry_after?: number };
      throw new AuthError(p.error ?? `http_${res.status}`, p.message ?? res.statusText ?? 'Request failed', res.status, p.retry_after);
    }
    return parsed as T;
  }

  // Persisted: refresh token + user. The access token is never stored.
  private async save(session: Session): Promise<void> {
    if (!this.storage) return;
    try {
      if (!(await this.storage.isAvailable())) return;
      await this.storage.set(AuthService.STORAGE_KEY, JSON.stringify({
        refresh_token: session.refresh_token,
        session_id: session.session_id,
        user: session.user,
      }));
    } catch (err) {
      console.warn('[auth] could not save the session', err);
    }
  }

  private async loadSaved(): Promise<Session | null> {
    if (!this.storage) return null;
    try {
      if (!(await this.storage.isAvailable())) return null;
      const raw = await this.storage.get(AuthService.STORAGE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as Partial<Session>;
      if (!v.refresh_token || !v.user?.id) return null;
      return {
        access_token: '',
        expires_at: 0,
        refresh_token: v.refresh_token,
        session_id: v.session_id ?? '',
        user: { ...v.user, user_metadata: v.user.user_metadata ?? {} },
      };
    } catch (err) {
      console.warn('[auth] could not read the saved session', err);
      return null;
    }
  }

  private async clearSaved(): Promise<void> {
    if (!this.storage) return;
    try {
      if (await this.storage.isAvailable()) await this.storage.remove(AuthService.STORAGE_KEY);
    } catch (err) {
      console.warn('[auth] could not clear the saved session', err);
    }
  }

  private setState(next: AuthState): void {
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
  }
}

// A sentence for the sign-in screen.
export function describeAuthError(err: unknown): string {
  if (!(err instanceof AuthError)) return err instanceof Error ? err.message : 'Something went wrong.';
  switch (err.code) {
    case 'invalid_credentials': return 'Wrong username, email or password.';
    case 'email_not_verified': return 'Verify your email address first — check your inbox for the link.';
    case 'account_disabled': return 'This account has been disabled.';
    case 'username_taken': return 'That username is taken.';
    case 'email_taken': return 'An account with that email already exists. Sign in instead, or reset your password.';
    case 'registration_closed': return 'Sign-ups are closed right now.';
    case 'invite_required': return 'Sign-ups need an invite code right now.';
    case 'rate_limited': return 'Too many attempts. Wait a minute and try again.';
    case 'network': return err.message;
    // invalid_username, weak_password, invalid_request: the service's own
    // message says what's wrong.
    default: return err.message;
  }
}
