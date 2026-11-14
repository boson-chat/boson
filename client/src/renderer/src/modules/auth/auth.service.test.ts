import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthService, AuthError, describeAuthError } from './auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { validateUsername } from './username';

// A fake of the auth service's REST API: refresh tokens rotate on every
// use, and presenting a used one revokes the session (as the real one does).
class FakeAuthApi {
  calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  users = new Map<string, { id: string; username: string; email: string; password: string; verified: boolean }>();
  live = new Set<string>();
  used = new Set<string>();
  requireVerification = true;
  delayMs = 0;
  down = false;
  // Access tokens the voice-token endpoint refuses (expired / revoked).
  rejectedAccess = new Set<string>();
  voiceAuth: string[] = [];
  private n = 0;

  transport = async (req: ApiRequest): Promise<ApiResponse> => {
    const path = new URL(req.url).pathname;
    const body = req.body ? JSON.parse(req.body as string) as Record<string, unknown> : {};
    this.calls.push({ path, body });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.down) return { status: 0, ok: false, statusText: 'connection refused', text: '' };
    const ok = (status: number, v: unknown): ApiResponse => ({ status, ok: true, statusText: 'OK', text: v === undefined ? '' : JSON.stringify(v) });
    const err = (status: number, error: string, message = error): ApiResponse => ({ status, ok: false, statusText: 'err', text: JSON.stringify({ error, message }) });
    switch (path) {
      case '/v1/register': {
        const username = String(body['username']);
        if ([...this.users.values()].some((u) => u.username.toLowerCase() === username.toLowerCase())) return err(409, 'username_taken');
        const id = `usr_${++this.n}`;
        this.users.set(id, { id, username, email: String(body['email']), password: String(body['password']), verified: !this.requireVerification });
        return ok(201, { user: {}, email_verification_sent: this.requireVerification, email_verification_required: this.requireVerification });
      }
      case '/v1/login': {
        const login = String(body['login']);
        const u = [...this.users.values()].find((x) => x.username === login || x.email === login);
        if (!u || u.password !== body['password']) return err(401, 'invalid_credentials', 'invalid credentials');
        if (!u.verified) return err(403, 'email_not_verified');
        return ok(200, this.tokens(u));
      }
      case '/v1/token/refresh': {
        const rt = String(body['refresh_token']);
        if (this.used.has(rt)) { this.live.clear(); return err(401, 'invalid_refresh_token'); }
        if (!this.live.has(rt)) return err(401, 'invalid_refresh_token');
        this.live.delete(rt);
        this.used.add(rt);
        const u = this.users.get(rt.split(':')[1]!)!;
        return ok(200, this.tokens(u));
      }
      case '/v1/logout':
        this.live.delete(String(body['refresh_token']));
        return ok(204, undefined);
      case '/v1/voice/token': {
        const auth = req.headers?.['Authorization'] ?? '';
        this.voiceAuth.push(auth);
        if (!auth.startsWith('Bearer ') || this.rejectedAccess.has(auth.slice(7))) return err(401, 'invalid_token');
        return ok(200, { token: `vt:${JSON.stringify(body['rooms'] ?? null)}`, expires_in: 300, audience: 'quicvoice' });
      }
      case '/v1/email/resend':
      case '/v1/password/forgot':
        return ok(202, {});
    }
    return err(404, 'not_found');
  };

  private tokens(u: { id: string; username: string; email: string }) {
    const rt = `rt${++this.n}:${u.id}`;
    this.live.add(rt);
    return {
      token_type: 'Bearer', access_token: `at${this.n}`, expires_in: 900, refresh_token: rt, refresh_expires_in: 2592000,
      session_id: 'ses_1', user: { id: u.id, username: u.username, email: u.email, email_verified: true, role: 'user' },
    };
  }

  count(path: string): number { return this.calls.filter((c) => c.path === path).length; }
}

describe('AuthService', () => {
  let api: FakeAuthApi;
  let storage: InMemorySecureStorage;
  let now: number;
  let svc: AuthService;

  beforeEach(() => {
    api = new FakeAuthApi();
    api.requireVerification = false;
    storage = new InMemorySecureStorage();
    now = 1_000_000;
    svc = new AuthService('https://auth.test/', { storage, transport: api.transport, now: () => now });
  });

  async function registered(): Promise<void> {
    await svc.signUp({ username: 'alice', email: 'alice@example.com', password: 'correct horse battery' });
  }

  it('starts loading and resolves to signed out with nothing saved', async () => {
    expect(svc.getState()).toEqual({ session: null, loading: true, error: null });
    await svc.init();
    expect(svc.getState()).toEqual({ session: null, loading: false, error: null });
  });

  it('sign-up without verification signs in and saves only the refresh token', async () => {
    await registered();
    const s = svc.getState().session!;
    expect(s.user).toMatchObject({ id: 'usr_1', username: 'alice', email: 'alice@example.com' });
    expect(await svc.getToken()).toBe(s.access_token);
    const saved = JSON.parse((await storage.get(AuthService.STORAGE_KEY))!);
    expect(saved.refresh_token).toBe(s.refresh_token);
    expect(saved.access_token).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('sign-up with verification required does not sign in', async () => {
    api.requireVerification = true;
    const r = await svc.signUp({ username: 'bob', email: 'bob@example.com', password: 'correct horse battery' });
    expect(r).toEqual({ verificationRequired: true });
    expect(svc.getState().session).toBeNull();
    await expect(svc.signIn('bob', 'correct horse battery')).rejects.toMatchObject({ code: 'email_not_verified', status: 403 });
  });

  it('gets a voice token with the access token, for given rooms', async () => {
    await registered();
    const access = svc.getState().session!.access_token;
    const t = await svc.voiceToken(['general']);
    expect(t).toEqual({ token: 'vt:["general"]', expiresAt: now + 300_000 });
    expect(api.voiceAuth).toEqual([`Bearer ${access}`]);
    expect((await svc.voiceToken()).token).toBe('vt:null');
    expect(api.calls.filter((c) => c.path === '/v1/voice/token').map((c) => c.body)).toEqual([{ rooms: ['general'] }, {}]);
  });

  it('a refused access token is refreshed once for a voice token', async () => {
    await registered();
    api.rejectedAccess.add(svc.getState().session!.access_token);
    const t = await svc.voiceToken();
    expect(t.token).toBe('vt:null');
    expect(api.count('/v1/token/refresh')).toBe(1);
    expect(api.voiceAuth).toHaveLength(2);
  });

  it('no voice token when signed out', async () => {
    await svc.init();
    await expect(svc.voiceToken()).rejects.toMatchObject({ code: 'signed_out' });
  });

  it('signs in with username or email; maps errors', async () => {
    await registered();
    await svc.signOut();
    await svc.signIn('alice@example.com', 'correct horse battery');
    expect(svc.getState().session?.user.username).toBe('alice');
    const err = await svc.signIn('alice', 'nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(describeAuthError(err)).toBe('Wrong username, email or password.');
  });

  it('refreshes an expiring access token, single-flight, rotating the saved token', async () => {
    await registered();
    const first = svc.getState().session!;
    now += 900_000; // expired
    api.delayMs = 5;
    const tokens = await Promise.all([svc.getToken(), svc.getToken(), svc.getToken(), svc.tokenRejected(first.access_token)]);
    expect(api.count('/v1/token/refresh')).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).not.toBe(first.access_token);
    const saved = JSON.parse((await storage.get(AuthService.STORAGE_KEY))!);
    expect(saved.refresh_token).toBe(svc.getState().session!.refresh_token);
    expect(saved.refresh_token).not.toBe(first.refresh_token);
  });

  it('tokenRejected refreshes once, then reuses the fresh token', async () => {
    await registered();
    const stale = svc.getState().session!.access_token;
    const fresh = await svc.tokenRejected(stale);
    expect(fresh).not.toBe(stale);
    expect(await svc.tokenRejected(stale)).toBe(fresh);
    expect(api.count('/v1/token/refresh')).toBe(1);
  });

  it('restores a saved session on init by refreshing', async () => {
    await registered();
    const again = new AuthService('https://auth.test', { storage, transport: api.transport, now: () => now });
    await again.init();
    const s = again.getState().session!;
    expect(s.user.username).toBe('alice');
    expect(s.access_token).not.toBe('');
    expect(again.getState().loading).toBe(false);
  });

  it('keeps the saved session when the auth service is unreachable at startup', async () => {
    await registered();
    api.down = true;
    const again = new AuthService('https://auth.test', { storage, transport: api.transport, now: () => now });
    await again.init();
    expect(again.getState().session?.user.id).toBe('usr_1');
    expect(await again.getToken()).toBeNull();
    api.down = false;
    expect(await again.getToken()).toMatch(/^at/);
  });

  it('signs out locally when the refresh token is rejected (e.g. reused)', async () => {
    await registered();
    const stolen = svc.getState().session!.refresh_token;
    now += 900_000;
    await svc.getToken(); // rotates
    api.used.add(stolen);
    // Someone replays the old token: the service revokes everything.
    await api.transport({ method: 'POST', url: 'https://auth.test/v1/token/refresh', headers: {}, body: JSON.stringify({ refresh_token: stolen }) });
    now += 900_000;
    expect(await svc.getToken()).toBeNull();
    expect(svc.getState().session).toBeNull();
    expect(await storage.get(AuthService.STORAGE_KEY)).toBeNull();
  });

  it('signOut revokes the session and forgets it; a racing refresh cannot resurrect it', async () => {
    await registered();
    now += 900_000;
    api.delayMs = 5;
    const pending = svc.getToken();
    await svc.signOut();
    await pending;
    expect(svc.getState().session).toBeNull();
    expect(await storage.get(AuthService.STORAGE_KEY)).toBeNull();
    expect(api.count('/v1/logout')).toBe(1);
  });

  it('updateMetadata caches profile fields across refreshes and restarts', async () => {
    await registered();
    const seen = vi.fn();
    svc.subscribe(seen);
    await svc.updateMetadata({ handle: 'ally' });
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ session: expect.objectContaining({ user: expect.objectContaining({ user_metadata: { handle: 'ally' } }) }) }));
    now += 900_000;
    await svc.getToken();
    expect(svc.getState().session!.user.user_metadata).toEqual({ handle: 'ally' });
  });

  it('resend and forgot hit the right endpoints', async () => {
    await svc.resendVerification(' a@example.com ');
    await svc.requestPasswordReset('a@example.com');
    expect(api.calls.map((c) => [c.path, c.body['email']])).toEqual([
      ['/v1/email/resend', 'a@example.com'],
      ['/v1/password/forgot', 'a@example.com'],
    ]);
  });

  it('reports network failures as AuthError(network)', async () => {
    api.down = true;
    await expect(svc.signIn('a', 'b')).rejects.toMatchObject({ code: 'network', status: 0 });
    const throwing = new AuthService('https://auth.test', { transport: async () => { throw new Error('boom'); } });
    await expect(throwing.signIn('a', 'b')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('validateUsername', () => {
  it('accepts IRC nicks', () => {
    for (const ok of ['alice', 'A', '[bot]', '_x-1', 'a'.repeat(30), '{z}|^`']) expect(validateUsername(ok)).toBeNull();
  });
  it('rejects the rest', () => {
    for (const bad of ['', '1abc', '-x', 'a b', 'a.b', 'é', 'a'.repeat(31), 'NickServ']) expect(validateUsername(bad)).not.toBeNull();
  });
});
