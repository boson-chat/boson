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
import { friendlyPasswordError, sentence } from './wording';
import type { FederatedIdentity } from '../netauth/federation';

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
  // A federated account (signed in with an account of another Boson
  // server, modules/netauth/federation.ts): who it was made from.
  federated?: FederatedIdentity;
}

export interface AuthState {
  session: Session | null;
  loading: boolean;
  error: string | null;
  // Set when the session ended on its own (the auth service refused its
  // refresh token: expired, revoked or signed out elsewhere), so the login
  // screen can say why instead of just appearing. Absent otherwise.
  signedOutReason?: 'expired';
}

export type AuthListener = (state: AuthState) => void;

// A quicvoiced token (POST /v1/voice/token).
export interface VoiceToken {
  token: string;
  // ms since the epoch.
  expiresAt: number;
}

// An identity provider the auth service offers ("Sign in with …").
export interface SSOProvider {
  slug: string;
  kind: 'oidc' | 'saml' | string;
  display_name: string;
  start_url: string;
}

// GET /v1/config: the network's public settings.
export interface AuthConfig {
  registration?: string;
  require_email_verification?: boolean;
  sso_providers: SSOProvider[];
  // New channels are registered to the logged-in user who creates them
  // (default true when absent on servers that know the setting).
  channel_auto_register?: boolean;
  // Registered channels nobody uses for this many days are dropped; 0 = never.
  channel_expiry_days?: number;
  // Whether people may use the network's IRC without an account (guests).
  // Absent on older servers: treat as true (guestAccessAllowed).
  guest_access?: boolean;
  // Whether guests (no account) may join voice and video with their IRC
  // nick (POST /v1/voice/guest-token). True only when guest_access is on
  // too; absent on older servers: no guest voice.
  guest_voice?: boolean;
  // The network's name, for "Sign in to <network>" (newer servers).
  site_name?: string;
  network_name?: string;
  // The network's theme document (boson-theme/1, GET /v1/branding).
  // null when the network has none.
  branding_url?: string | null;
  // Who may create IRC channels: anyone signed in ("registered", the
  // default) or only admins (roles with irc.chanreg; Ergo's
  // operator-only-creation). Absent on older servers: "registered".
  channel_creation?: 'registered' | 'admins' | string;
  // The network channels (fixed channels its services keep), with the ones
  // new people are joined to. Absent on older servers.
  channels?: NetworkChannel[];
}

export interface NetworkChannel {
  name: string;
  topic?: string;
  autojoin?: boolean;
}

// GET /v1/me: the signed-in user's roles and effective permissions
// (e.g. "irc.chanreg").
export interface AuthMe {
  roles: { id?: string; name: string }[];
  permissions: string[];
}

// guest_access, defaulting to allowed when the server doesn't say.
export function guestAccessAllowed(cfg: Pick<AuthConfig, 'guest_access'> | null | undefined): boolean {
  return cfg?.guest_access !== false;
}

// An external sign-in linked to the account (GET /v1/me/identities).
export interface LinkedIdentity {
  id: string;
  provider_id: string;
  provider_slug: string;
  provider_kind: string;
  provider_display_name: string;
  subject: string;
  email: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface LinkedIdentities {
  identities: LinkedIdentity[];
  has_password: boolean;
}

export interface SignUpInput {
  username: string;
  email: string;
  password: string;
  // Needed when the network's registration is invite-only.
  invite_code?: string;
}

export interface SignUpResult {
  // The account exists but can't sign in until the emailed link is opened.
  verificationRequired: boolean;
}

// An error from the auth service: `code` is its machine-readable error
// (invalid_credentials, email_not_verified, username_taken, …), or
// 'network' when it couldn't be reached.
// Where the auth service's /verify-email page sends the user after the
// emailed link is opened (auth#26): back to this web app, or into the
// desktop / mobile app through its boson:// link. Older auth services
// ignore the field.
export function verifyReturnTo(): string {
  if (typeof window !== 'undefined' && (window as { bosonShell?: string }).bosonShell === 'web') {
    return `${window.location.origin}/`;
  }
  return 'boson://verified';
}

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

// The remote's answer to a federated login (spec §3.6).
interface FederatedTokenResponse extends TokenResponse {
  federated?: boolean;
  identity?: string;
  handle?: string;
}

export interface AuthServiceOptions {
  storage?: SecureStorage;
  // Where the session is kept in storage (default STORAGE_KEY, the app's
  // own account). Each network's auth service gets its own key.
  storageKey?: string;
  transport?: ApiTransport;
  now?: () => number;
}

// Refresh this long before the access token expires.
const EXPIRY_SKEW_MS = 60_000;

export class AuthService {
  static readonly STORAGE_KEY = 'boson.auth.session';

  readonly baseUrl: string;
  private readonly storageKey: string;
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
    this.storageKey = opts.storageKey ?? AuthService.STORAGE_KEY;
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
    this.setState({ ...this.state, loading: false, error: null });
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

  // The network's public settings, including its identity providers.
  async config(): Promise<AuthConfig> {
    const r = await this.call<Partial<AuthConfig>>('GET', '/v1/config');
    return { ...r, sso_providers: Array.isArray(r?.sso_providers) ? r.sso_providers.filter((p) => p?.slug && p.start_url) : [] };
  }

  // Finishes "Sign in with …": trades the one-time code the browser brought
  // back (and the PKCE verifier its start carried the challenge of) for a
  // session, stored like a password sign-in's.
  async exchangeSSOCode(code: string, codeVerifier: string): Promise<Session> {
    const r = await this.call<TokenResponse>('POST', '/v1/sso/exchange', { code, code_verifier: codeVerifier });
    this.epoch++;
    const session = this.toSession(r, {});
    await this.save(session);
    this.setState({ session, loading: false, error: null });
    return session;
  }

  // Federated sign-in, home side: a short-lived identity assertion for
  // `audience` (the remote's issuer), with this account's access token.
  // endpoint must be on this service's origin (the token never goes
  // elsewhere). Throws AuthError ('signed_out' without a session).
  async federationAssertion(endpoint: string, audience: string): Promise<{ assertion: string; expires_in?: number }> {
    return this.authed('POST', endpoint, { audience });
  }

  // Federated sign-in, remote side: trades a home server's assertion for
  // this service's own session, stored like a password sign-in's and
  // marked federated. endpoint: on this service's origin.
  async federatedLogin(endpoint: string, assertion: string, from: { homeAuthUrl: string; homeDomain: string; identity: string }): Promise<Session> {
    const r = await this.call<FederatedTokenResponse>('POST', endpoint, { assertion });
    if (!r?.access_token || !r.refresh_token || !r.user?.id) {
      throw new AuthError('invalid_response', 'The sign-in service sent no session.', 200);
    }
    this.epoch++;
    const handle = (typeof r.handle === 'string' && r.handle) || r.user.username;
    const session: Session = {
      ...this.toSession(r, {}),
      federated: {
        identity: (typeof r.identity === 'string' && r.identity) || from.identity,
        handle,
        homeAuthUrl: from.homeAuthUrl,
        homeDomain: from.homeDomain,
      },
    };
    await this.save(session);
    this.setState({ session, loading: false, error: null });
    return session;
  }

  // External sign-ins linked to the account, and whether it has a password.
  async identities(): Promise<LinkedIdentities> {
    const r = await this.authed<Partial<LinkedIdentities>>('GET', '/v1/me/identities');
    return { identities: r?.identities ?? [], has_password: !!r?.has_password };
  }

  // The signed-in user's roles and permissions on this network.
  async me(): Promise<AuthMe> {
    const r = await this.authed<Partial<{ roles: unknown; permissions: unknown }>>('GET', '/v1/me');
    const perms = Array.isArray(r?.permissions) ? r.permissions.filter((p): p is string => typeof p === 'string') : [];
    const roles = Array.isArray(r?.roles)
      ? r.roles.filter((x): x is { id?: string; name: string } => !!x && typeof (x as { name?: unknown }).name === 'string')
      : [];
    return { roles, permissions: perms };
  }

  // Unlinks one; 409 last_login_method when it's the only way in.
  async unlinkIdentity(id: string): Promise<void> {
    await this.authed('DELETE', `/v1/me/identities/${encodeURIComponent(id)}`);
  }

  // An authenticated request to this auth service's API (friends, calls):
  // throws AuthError, 'signed_out' without a session.
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.authed<T>(method, path, body);
  }

  // A call with the access token, retried once after a refresh on 401.
  private async authed<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let token = await this.getToken();
    if (!token) throw new AuthError('signed_out', 'Sign in first.', 401);
    try {
      return await this.call<T>(method, path, body, token);
    } catch (err) {
      if (!(err instanceof AuthError) || err.status !== 401) throw err;
      token = await this.tokenRejected(token);
      if (!token) throw new AuthError('signed_out', 'Sign in first.', 401);
      return this.call<T>(method, path, body, token);
    }
  }

  async signUp(input: SignUpInput): Promise<SignUpResult> {
    const r = await this.call<{ email_verification_required: boolean }>('POST', '/v1/register', {
      username: input.username.trim(),
      email: input.email.trim(),
      password: input.password,
      ...(input.invite_code?.trim() ? { invite_code: input.invite_code.trim() } : {}),
      return_to: verifyReturnTo(),
    });
    if (r.email_verification_required) return { verificationRequired: true };
    await this.signIn(input.username, input.password);
    return { verificationRequired: false };
  }

  // Same 202 whether or not the account exists.
  async resendVerification(email: string): Promise<void> {
    await this.call('POST', '/v1/email/resend', { email: email.trim(), return_to: verifyReturnTo() });
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

  // A guest voice token (POST /v1/voice/guest-token, no account): the voice
  // server shows `nick` with a guest badge. guestId is the app's random id
  // for this auth service (guestVoiceId). Throws AuthError: 403
  // guest_voice_disabled, 400 invalid, 409 nick_registered, 429.
  async guestVoiceToken(nick: string, guestId: string, rooms?: string[]): Promise<VoiceToken> {
    const body = { nick, guest_id: guestId, ...(rooms && rooms.length > 0 ? { rooms } : {}) };
    const r = await this.call<{ token?: string; expires_in?: number }>('POST', '/v1/voice/guest-token', body);
    if (!r?.token) throw new AuthError('invalid_response', 'The sign-in service sent no voice token.', 200);
    return { token: r.token, expiresAt: this.now() + (r.expires_in ?? 300) * 1000 };
  }

  private async voiceTokenWith(accessToken: string, body: unknown): Promise<VoiceToken> {
    const r = await this.call<{ token?: string; expires_in?: number }>('POST', '/v1/voice/token', body, accessToken);
    if (!r?.token) throw new AuthError('invalid_response', 'The sign-in service sent no voice token.', 200);
    return { token: r.token, expiresAt: this.now() + (r.expires_in ?? 300) * 1000 };
  }

  // Single-flight refresh. Resolves null (and signs out locally) when the
  // auth service rejects the refresh token; throws on network errors.
  //
  // Other windows of the app (browser tabs of the web build) share the saved
  // session and its rotating refresh token. Presenting a token another tab
  // already rotated would look like reuse and revoke the session for every
  // tab, so refreshes are serialised across tabs (Web Locks, where there)
  // and each one starts from the newest saved token.
  refresh(): Promise<Session | null> {
    if (this.refreshing) return this.refreshing;
    if (!this.state.session) return Promise.resolve(null);
    const epoch = this.epoch;
    this.refreshing = withRefreshLock(this.storageKey, async () => {
      try {
        let current = this.state.session;
        if (!current || epoch !== this.epoch) return this.state.session;
        const saved = await this.loadSaved();
        if (saved && saved.user.id === current.user.id && saved.refresh_token !== current.refresh_token) {
          current = { ...current, refresh_token: saved.refresh_token, session_id: saved.session_id || current.session_id };
        }
        if (epoch !== this.epoch) return this.state.session;
        const r = await this.call<TokenResponse>('POST', '/v1/token/refresh', { refresh_token: current.refresh_token });
        if (epoch !== this.epoch) return this.state.session;
        const session: Session = {
          ...this.toSession(r, current.user.user_metadata),
          ...(current.federated ? { federated: current.federated } : {}),
        };
        await this.save(session);
        this.setState({ ...this.state, session });
        return session;
      } catch (err) {
        if (err instanceof AuthError && err.status === 401 && epoch === this.epoch) {
          // Expired, revoked or reused: the session is over.
          this.epoch++;
          await this.clearSaved();
          this.setState({ session: null, loading: false, error: null, signedOutReason: 'expired' });
          return null;
        }
        throw err;
      } finally {
        this.refreshing = null;
      }
    });
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
    // An absolute URL (a boson.json endpoint) must be on this service's
    // origin: its tokens go nowhere else.
    let url = `${this.baseUrl}${path}`;
    if (/^https?:\/\//i.test(path)) {
      if (originOf(path) !== originOf(this.baseUrl)) {
        throw new AuthError('foreign_endpoint', `${path} isn't on this sign-in service.`, 0);
      }
      url = path;
    }
    try {
      res = await this.transport({
        method,
        url,
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
      await this.storage.set(this.storageKey, JSON.stringify({
        refresh_token: session.refresh_token,
        session_id: session.session_id,
        user: session.user,
        ...(session.federated ? { federated: session.federated } : {}),
      }));
    } catch (err) {
      console.warn('[auth] could not save the session', err);
    }
  }

  private async loadSaved(): Promise<Session | null> {
    if (!this.storage) return null;
    try {
      if (!(await this.storage.isAvailable())) return null;
      const raw = await this.storage.get(this.storageKey);
      if (!raw) return null;
      const v = JSON.parse(raw) as Partial<Session>;
      if (!v.refresh_token || !v.user?.id) return null;
      return {
        access_token: '',
        expires_at: 0,
        refresh_token: v.refresh_token,
        session_id: v.session_id ?? '',
        user: { ...v.user, user_metadata: v.user.user_metadata ?? {} },
        ...(validFederated(v.federated) ? { federated: v.federated } : {}),
      };
    } catch (err) {
      console.warn('[auth] could not read the saved session', err);
      return null;
    }
  }

  private async clearSaved(): Promise<void> {
    if (!this.storage) return;
    try {
      if (await this.storage.isAvailable()) await this.storage.remove(this.storageKey);
    } catch (err) {
      console.warn('[auth] could not clear the saved session', err);
    }
  }

  private setState(next: AuthState): void {
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
  }
}

function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return ''; }
}

function validFederated(f: unknown): f is FederatedIdentity {
  if (!f || typeof f !== 'object') return false;
  const v = f as Record<string, unknown>;
  return typeof v['identity'] === 'string' && typeof v['handle'] === 'string'
    && typeof v['homeAuthUrl'] === 'string' && typeof v['homeDomain'] === 'string';
}

// Runs `fn` holding a lock shared by every tab of this origin (the Web Locks
// API), so two tabs never present the same refresh token. Without the API
// (older webviews, tests) it just runs.
function withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined'
    ? (navigator as { locks?: { request?: (name: string, cb: () => Promise<unknown>) => Promise<unknown> } }).locks
    : undefined;
  if (typeof locks?.request !== 'function') return fn();
  return locks.request(`boson-auth-refresh:${key}`, fn) as Promise<T>;
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
    case 'invalid_code': return 'That sign-in expired before it finished. Try again.';
    case 'last_login_method': return "That's the only way to sign in to this account. Set a password or link another sign-in first.";
    case 'weak_password': return friendlyPasswordError(err.message);
    // invalid_username, invalid_request: the service's own message says
    // what's wrong (as a sentence).
    default: return sentence(err.message);
  }
}
