import { describe, it, expect } from 'vitest';
import { AuthService, AuthError } from './auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { pkcePair, signInWithProvider, ssoStartUrl, type SSOBridge } from './sso';

const TOKENS = {
  token_type: 'Bearer', access_token: 'at1', expires_in: 900, refresh_token: 'rt1', refresh_expires_in: 1, session_id: 'ses_1',
  user: { id: 'usr_1', username: 'ada', email: null, email_verified: false, role: 'user' },
};

function api(handler: (req: ApiRequest, body: Record<string, unknown>) => [number, unknown]) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown>; auth?: string }> = [];
  const transport = async (req: ApiRequest): Promise<ApiResponse> => {
    const body = req.body ? JSON.parse(req.body as string) as Record<string, unknown> : {};
    calls.push({ method: req.method, path: new URL(req.url).pathname, body, auth: req.headers.Authorization });
    const [status, v] = handler(req, body);
    return { status, ok: status < 400, statusText: '', text: v === undefined ? '' : JSON.stringify(v) };
  };
  return { calls, transport };
}

describe('SSO', () => {
  it('makes an RFC 7636 S256 pair', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
  });

  it('keeps start_url and adds return_to and the challenge', () => {
    const u = new URL(ssoStartUrl('https://auth.example/v1/sso/dex/start?invite_code=x', 'http://127.0.0.1:1234/callback?s=abc', 'CH'));
    expect(u.searchParams.get('invite_code')).toBe('x');
    expect(u.searchParams.get('return_to')).toBe('http://127.0.0.1:1234/callback?s=abc');
    expect(u.searchParams.get('code_challenge')).toBe('CH');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges the code with the verifier and stores the session', async () => {
    const { calls, transport } = api((req) => (new URL(req.url).pathname === '/v1/sso/exchange' ? [200, TOKENS] : [404, {}]));
    const storage = new InMemorySecureStorage();
    const auth = new AuthService('https://auth.example', { transport, storage });
    let opened = '';
    const bridge: SSOBridge = {
      begin: async () => ({ id: 'f', redirectUri: 'http://127.0.0.1:1/callback?s=1' }),
      wait: async () => ({ code: 'bsc_abc' }),
      cancel: async () => {},
      open: async (u) => { opened = u; },
    };
    const s = await signInWithProvider(auth, bridge, { slug: 'dex', kind: 'oidc', display_name: 'Dex', start_url: 'https://auth.example/v1/sso/dex/start' }).done;
    expect(s.user.username).toBe('ada');
    expect(auth.getState().session?.access_token).toBe('at1');
    expect(await storage.get(AuthService.STORAGE_KEY)).toContain('rt1');
    const ex = calls.find((c) => c.path === '/v1/sso/exchange')!;
    expect(ex.body['code']).toBe('bsc_abc');
    const challenge = new URL(opened).searchParams.get('code_challenge');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(ex.body['code_verifier']))));
    expect(btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).toBe(challenge);
  });

  it('turns callback errors into AuthErrors', async () => {
    const auth = new AuthService('https://auth.example', { transport: api(() => [500, {}]).transport });
    const bridge: SSOBridge = {
      begin: async () => ({ id: 'f', redirectUri: 'http://127.0.0.1:1/callback' }),
      wait: async () => ({ error: 'registration_closed', errorDescription: 'closed' }),
      cancel: async () => {}, open: async () => {},
    };
    const err = await signInWithProvider(auth, bridge, { slug: 'dex', kind: 'oidc', display_name: 'Dex', start_url: 'https://auth.example/s' }).done.catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe('registration_closed');
  });

  it('reads providers, lists and unlinks identities with the access token', async () => {
    const { calls, transport } = api((req) => {
      const p = new URL(req.url).pathname;
      if (p === '/v1/login') return [200, TOKENS];
      if (p === '/v1/config') return [200, { registration: 'open', sso_providers: [{ slug: 'dex', kind: 'oidc', display_name: 'Dex', start_url: 'https://a/s' }, { slug: '' }] }];
      if (p === '/v1/me/identities') return [200, { identities: [{ id: 'uid_1', provider_slug: 'dex' }], has_password: false }];
      if (p === '/v1/me/identities/uid_1') return [409, { error: 'last_login_method', message: 'no' }];
      return [404, {}];
    });
    const auth = new AuthService('https://auth.example', { transport });
    expect((await auth.config()).sso_providers.map((p) => p.slug)).toEqual(['dex']);
    await auth.signIn('ada', 'pw');
    const ids = await auth.identities();
    expect(ids.has_password).toBe(false);
    expect(calls.find((c) => c.path === '/v1/me/identities')?.auth).toBe('Bearer at1');
    const err = await auth.unlinkIdentity('uid_1').catch((e) => e);
    expect((err as AuthError).code).toBe('last_login_method');
    expect(calls.at(-1)?.method).toBe('DELETE');
  });
});
