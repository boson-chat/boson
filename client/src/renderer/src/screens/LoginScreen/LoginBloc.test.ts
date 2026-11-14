import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoginBloc, type LoginState } from './LoginBloc';
import { AuthError, type AuthService, type SSOBridge } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { HttpError } from '../../shared/http/http.client';

// Test doubles: fake services with mocked-out methods that the bloc exercises.
// We deliberately type them as the public service interfaces so the bloc sees
// the same shape it would in production.

function buildFakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  const base = {
    signIn: vi.fn(async () => {}),
    signUp: vi.fn(async () => ({ verificationRequired: true })),
    resendVerification: vi.fn(async () => {}),
    requestPasswordReset: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    getToken: vi.fn(async () => 'jwt'),
    getState: vi.fn(() => ({ session: null, loading: false, error: null })),
    subscribe: vi.fn(() => () => {}),
    init: vi.fn(async () => {}),
    markFatal: vi.fn(),
  };
  return { ...base, ...overrides } as unknown as AuthService;
}

function buildFakeDirectory(overrides: Partial<DirectoryService> = {}): DirectoryService {
  const base = {
    listServers: vi.fn(async () => []),
    getMe: vi.fn(async () => null),
    setupMe: vi.fn(async () => ({ id: 'u', handle: 'x', is_discoverable: true, encrypted_user_secret: '', created_at: '' })),
    deleteMe: vi.fn(async () => {}),
  } as unknown as DirectoryService;
  return { ...base, ...overrides } as DirectoryService;
}

function buildFakeIdentity(overrides: Partial<IdentityService> = {}): IdentityService {
  const base = {
    isUnlocked: vi.fn(() => false),
    getState: vi.fn(() => ({ status: 'locked' as const })),
    subscribe: vi.fn(() => () => {}),
    initializeForNewUser: vi.fn(async () => 'pending-blob-b64'),
    unlock: vi.fn(async () => {}),
    saslPasswordForServer: vi.fn(async () => 'pw'),
    lock: vi.fn(),
    getPendingEncrypted: vi.fn(() => null),
    clearPendingEncrypted: vi.fn(),
    persist: vi.fn(async () => true),
    restoreFromStorage: vi.fn(async () => false),
    clearStorage: vi.fn(async () => {}),
  } as unknown as IdentityService;
  return { ...base, ...overrides } as IdentityService;
}

interface Harness {
  auth: AuthService;
  directory: DirectoryService;
  identity: IdentityService;
  bloc: LoginBloc;
}

function buildBloc(opts: {
  auth?: Partial<AuthService>;
  directory?: Partial<DirectoryService>;
  identity?: Partial<IdentityService>;
  sso?: SSOBridge | null;
} = {}): Harness {
  const auth = buildFakeAuth(opts.auth);
  const directory = buildFakeDirectory(opts.directory);
  const identity = buildFakeIdentity(opts.identity);
  const bloc = new LoginBloc({ auth, directory, identity, sso: opts.sso ?? null });
  return { auth, directory, identity, bloc };
}

describe('LoginBloc', () => {
  describe('initial state', () => {
    it('starts in login mode with empty fields and no errors', () => {
      const { bloc } = buildBloc();
      const s = bloc.getState();
      expect(s).toEqual<LoginState>({
        mode: 'login',
        login: '',
        username: '',
        email: '',
        password: '',
        confirmPassword: '',
        busy: false,
        error: null,
        unrecoverable: null,
        recoverable: null,
        awaitingConfirmation: null,
        forgotOpen: false,
        notice: null,
        ssoProviders: [],
        ssoPending: null,
        identityPrompt: null,
      });
    });

    it('subscribe fires immediately with the current state', () => {
      const { bloc } = buildBloc();
      const seen: LoginState[] = [];
      bloc.subscribe((s) => seen.push(s));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.mode).toBe('login');
    });

    it('subscribe returns an unsubscriber that stops further callbacks', () => {
      const { bloc } = buildBloc();
      const fn = vi.fn();
      const off = bloc.subscribe(fn);
      fn.mockClear();
      off();
      bloc.setEmail('a@b');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('field setters', () => {
    it('setEmail updates state and notifies', () => {
      const { bloc } = buildBloc();
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.setEmail('alice@test.dev');
      expect(bloc.getState().email).toBe('alice@test.dev');
      expect(fn).toHaveBeenCalledOnce();
    });

    it('setPassword updates state', () => {
      const { bloc } = buildBloc();
      bloc.setPassword('secret');
      expect(bloc.getState().password).toBe('secret');
    });

    it('setConfirmPassword updates state', () => {
      const { bloc } = buildBloc();
      bloc.setConfirmPassword('secret');
      expect(bloc.getState().confirmPassword).toBe('secret');
    });

    it('setMode switches mode and clears any prior error', () => {
      const { bloc } = buildBloc();
      // Seed an error via a failed signIn so we can verify setMode wipes it.
      (bloc as unknown as { state: LoginState }).state = {
        ...bloc.getState(),
        error: 'stale error',
      };
      bloc.setMode('signup');
      expect(bloc.getState().mode).toBe('signup');
      expect(bloc.getState().error).toBeNull();
    });

    it('repeated setEmail with the same value is a no-op (no notification)', () => {
      const { bloc } = buildBloc();
      bloc.setEmail('a@b');
      const fn = vi.fn();
      bloc.subscribe(fn);
      fn.mockClear();
      bloc.setEmail('a@b');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('signIn', () => {
    it('success path with no /me row initializes a new identity', async () => {
      const { bloc, auth, directory, identity } = buildBloc({
        directory: { getMe: vi.fn(async () => null) } as Partial<DirectoryService>,
      });
      bloc.setLogin('alice@test.dev');
      bloc.setPassword('secret123');
      await bloc.signIn();

      expect(auth.signIn).toHaveBeenCalledWith('alice@test.dev', 'secret123');
      expect(directory.getMe).toHaveBeenCalled();
      expect(identity.initializeForNewUser).toHaveBeenCalledWith('secret123');
      const s = bloc.getState();
      expect(s.busy).toBe(false);
      expect(s.error).toBeNull();
    });

    it('success path with an existing /me row unlocks the identity', async () => {
      const me = { id: 'u', handle: 'alice', is_discoverable: true, encrypted_user_secret: 'stored-b64', created_at: '' };
      const { bloc, identity } = buildBloc({
        directory: { getMe: vi.fn(async () => me) } as Partial<DirectoryService>,
      });
      bloc.setLogin('alice@test.dev');
      bloc.setPassword('secret123');
      await bloc.signIn();

      expect(identity.unlock).toHaveBeenCalledWith('secret123', 'stored-b64');
      expect(identity.initializeForNewUser).not.toHaveBeenCalled();
      expect(bloc.getState().busy).toBe(false);
      expect(bloc.getState().error).toBeNull();
    });

    it('treats getMe 404 (HttpError) as needs-setup and initializes a new identity', async () => {
      const getMe = vi.fn(async () => { throw new HttpError(404, 'needs_setup'); });
      const { bloc, identity } = buildBloc({
        directory: { getMe } as Partial<DirectoryService>,
      });
      bloc.setLogin('alice@test.dev');
      bloc.setPassword('pw');
      await bloc.signIn();

      expect(identity.initializeForNewUser).toHaveBeenCalledWith('pw');
      expect(bloc.getState().error).toBeNull();
    });

    it('a non-404 HttpError from getMe propagates to the error field', async () => {
      const getMe = vi.fn(async () => { throw new HttpError(500, 'internal'); });
      const { bloc, identity } = buildBloc({
        directory: { getMe } as Partial<DirectoryService>,
      });
      bloc.setLogin('alice@test.dev');
      bloc.setPassword('pw');
      await bloc.signIn();

      expect(identity.initializeForNewUser).not.toHaveBeenCalled();
      expect(bloc.getState().error).toBe('internal');
      expect(bloc.getState().busy).toBe(false);
    });

    it('"blob too short" unlock error surfaces the unrecoverable + Start-fresh state', async () => {
      const me = { id: 'u', handle: 'alice', is_discoverable: true, encrypted_user_secret: 'YWJjZA==', created_at: '' };
      const unlock = vi.fn(async () => { throw new Error('encrypted_user_secret: blob too short'); });
      const { bloc } = buildBloc({
        directory: { getMe: vi.fn(async () => me) } as Partial<DirectoryService>,
        identity: { unlock } as Partial<IdentityService>,
      });
      bloc.setLogin('alice@test.dev');
      bloc.setPassword('pw');
      await bloc.signIn();

      const s = bloc.getState();
      expect(s.unrecoverable).toContain('blob too short');
      expect(s.error).toMatch(/Start fresh to recreate it/);
      expect(s.busy).toBe(false);
    });

    it('non-blob-too-short unlock error sets a friendly error WITHOUT unrecoverable', async () => {
      const me = { id: 'u', handle: 'alice', is_discoverable: true, encrypted_user_secret: 'longblob', created_at: '' };
      const unlock = vi.fn(async () => { throw new Error('OperationError: decrypt failed'); });
      const { bloc } = buildBloc({
        directory: { getMe: vi.fn(async () => me) } as Partial<DirectoryService>,
        identity: { unlock } as Partial<IdentityService>,
      });
      bloc.setLogin('alice@test.dev');
      bloc.setPassword('wrong');
      await bloc.signIn();

      const s = bloc.getState();
      expect(s.unrecoverable).toBeNull();
      expect(s.error).toMatch(/Couldn't decrypt your identity key/);
      expect(s.busy).toBe(false);
    });

    it('auth.signIn rejection surfaces the error and clears busy', async () => {
      const { bloc } = buildBloc({
        auth: { signIn: vi.fn(async () => { throw new Error('Invalid login credentials'); }) } as Partial<AuthService>,
      });
      bloc.setLogin('a@b');
      bloc.setPassword('wrong');
      await bloc.signIn();

      const s = bloc.getState();
      expect(s.error).toBe('Invalid login credentials');
      expect(s.busy).toBe(false);
    });

    it('flips busy=true mid-flight and back to false on completion', async () => {
      let resolveSignIn: () => void = () => {};
      const signIn = vi.fn(() => new Promise<void>((res) => { resolveSignIn = res; }));
      const { bloc } = buildBloc({ auth: { signIn } as Partial<AuthService> });

      bloc.setLogin('a@b');
      bloc.setPassword('pw');
      const p = bloc.signIn();
      // busy should be true while signIn is pending.
      expect(bloc.getState().busy).toBe(true);
      resolveSignIn();
      await p;
      expect(bloc.getState().busy).toBe(false);
    });
  });

  describe('signUp', () => {
    it('happy path calls auth.signUp and parks in awaitingConfirmation', async () => {
      const { bloc, auth, identity } = buildBloc();
      bloc.setUsername('bob');
      bloc.setEmail('bob@test.dev');
      bloc.setPassword('secret456');
      await bloc.signUp();

      expect(auth.signUp).toHaveBeenCalledWith({ username: 'bob', email: 'bob@test.dev', password: 'secret456' });
      // Identity is intentionally NOT initialized here — there's no
      // session until the email is verified and the user signs in. That
      // first sign-in mints the identity.
      expect(identity.initializeForNewUser).not.toHaveBeenCalled();
      expect(bloc.getState().busy).toBe(false);
      expect(bloc.getState().error).toBeNull();
      expect(bloc.getState().awaitingConfirmation).toBe('bob@test.dev');
      // Continue will sign in by username.
      expect(bloc.getState().login).toBe('bob');
    });

    it('rejects an invalid username before calling the service', async () => {
      const { bloc, auth } = buildBloc();
      bloc.setUsername('9 lives');
      expect(bloc.usernameProblem()).toMatch(/letter/);
      bloc.setEmail('x@test.dev');
      bloc.setPassword('secret456');
      await bloc.signUp();
      expect(auth.signUp).not.toHaveBeenCalled();
      expect(bloc.getState().error).toMatch(/^Username:/);
    });

    it('without verification (signUp signed in), creates the identity right away', async () => {
      const { bloc, identity } = buildBloc({
        auth: { signUp: vi.fn(async () => ({ verificationRequired: false })) } as Partial<AuthService>,
      });
      bloc.setUsername('bob');
      bloc.setEmail('bob@test.dev');
      bloc.setPassword('secret456');
      await bloc.signUp();
      expect(identity.initializeForNewUser).toHaveBeenCalledWith('secret456');
      expect(bloc.getState().awaitingConfirmation).toBeNull();
    });

    it('cancelAwaitingConfirmation clears the parked state without losing email', () => {
      const { bloc } = buildBloc();
      bloc.setUsername('bob');
      bloc.setEmail('bob@test.dev');
      // Manually seed the awaiting state — we want this test to
      // exercise cancel without depending on the signUp call shape.
      void bloc.signUp();
      bloc.cancelAwaitingConfirmation();
      expect(bloc.getState().awaitingConfirmation).toBeNull();
      expect(bloc.getState().email).toBe('bob@test.dev');
    });

    it("emits a Passwords don't match error when confirm differs", async () => {
      const { bloc, auth } = buildBloc();
      bloc.setMode('signup');
      bloc.setUsername('bob');
      bloc.setEmail('bob@test.dev');
      bloc.setPassword('a');
      bloc.setConfirmPassword('b');
      await bloc.signUp();

      expect(auth.signUp).not.toHaveBeenCalled();
      expect(bloc.getState().error).toBe("Passwords don't match.");
    });

    it('auth.signUp rejection surfaces the error', async () => {
      const { bloc } = buildBloc({
        auth: { signUp: vi.fn(async () => { throw new AuthError('email_taken', 'email taken', 409); }) } as Partial<AuthService>,
      });
      bloc.setUsername('bob');
      bloc.setPassword('pw');
      await bloc.signUp();

      expect(bloc.getState().error).toMatch(/already exists/);
      expect(bloc.getState().busy).toBe(false);
    });
  });

  describe('startFresh', () => {
    it('calls directory.deleteMe and identity.initializeForNewUser with the held password', async () => {
      const deleteMe = vi.fn(async () => {});
      const initializeForNewUser = vi.fn(async () => 'new-blob');
      const { bloc } = buildBloc({
        directory: { deleteMe } as Partial<DirectoryService>,
        identity: { initializeForNewUser } as Partial<IdentityService>,
      });
      bloc.setPassword('pw');
      await bloc.startFresh();

      expect(deleteMe).toHaveBeenCalledOnce();
      expect(initializeForNewUser).toHaveBeenCalledWith('pw');
      expect(bloc.getState().busy).toBe(false);
      expect(bloc.getState().error).toBeNull();
    });

    it('keeps the unrecoverable flag visible on failure so the user can retry', async () => {
      const deleteMe = vi.fn(async () => { throw new Error('network down'); });
      const { bloc } = buildBloc({
        directory: { deleteMe } as Partial<DirectoryService>,
      });
      // Seed unrecoverable as if a prior unlock failed with "blob too short".
      (bloc as unknown as { state: LoginState }).state = {
        ...bloc.getState(),
        password: 'pw',
        unrecoverable: 'blob too short',
        error: 'prior message',
      };

      await bloc.startFresh();

      const s = bloc.getState();
      expect(s.error).toBe('network down');
      expect(s.unrecoverable).toBe('blob too short');
      expect(s.busy).toBe(false);
    });
  });

  describe('setMode resets errors', () => {
    beforeEach(() => { /* fresh bloc per-test via buildBloc() */ });

    it('clears error when switching from login to signup', async () => {
      const { bloc } = buildBloc({
        auth: { signIn: vi.fn(async () => { throw new Error('boom'); }) } as Partial<AuthService>,
      });
      bloc.setPassword('x');
      await bloc.signIn();
      expect(bloc.getState().error).toBe('boom');
      bloc.setMode('signup');
      expect(bloc.getState().error).toBeNull();
      expect(bloc.getState().mode).toBe('signup');
    });
  });
});

describe('LoginBloc — recovery code', () => {
  const meWithRecovery = {
    id: 'u', handle: 'alice', is_discoverable: true,
    encrypted_user_secret: 'pw-wrap', encrypted_user_secret_recovery: 'rec-wrap', created_at: '',
  };

  it('signIn surfaces the recovery path when the password wrap won\'t decrypt but a recovery wrap exists', async () => {
    const { bloc } = buildBloc({
      directory: { getMe: vi.fn(async () => meWithRecovery) } as Partial<DirectoryService>,
      identity: { unlock: vi.fn(async () => { throw new Error('wrong password'); }) } as Partial<IdentityService>,
    });
    bloc.setLogin('a@b.com');
    bloc.setPassword('new-pw');
    await bloc.signIn();
    expect(bloc.getState().recoverable).toBe('rec-wrap');
    expect(bloc.getState().error).toMatch(/recovery code/i);
  });

  it('recoverWithCode unlocks, re-wraps under the current password, and clears the recovery state', async () => {
    const unlockWithRecoveryCode = vi.fn(async () => {});
    const rewrapForNewPassword = vi.fn(async () => 'new-pw-wrap');
    const updateSecretWraps = vi.fn(async () => meWithRecovery);
    const { bloc } = buildBloc({
      directory: {
        getMe: vi.fn(async () => meWithRecovery),
        updateSecretWraps,
      } as Partial<DirectoryService>,
      identity: {
        unlock: vi.fn(async () => { throw new Error('wrong password'); }),
        unlockWithRecoveryCode,
        rewrapForNewPassword,
      } as Partial<IdentityService>,
    });
    bloc.setPassword('new-pw');
    await bloc.signIn();          // → recoverable set
    await bloc.recoverWithCode('abcd-ef5h');

    expect(unlockWithRecoveryCode).toHaveBeenCalledWith('abcd-ef5h', 'rec-wrap');
    expect(rewrapForNewPassword).toHaveBeenCalledWith('new-pw');
    expect(updateSecretWraps).toHaveBeenCalledWith({ passwordBlob: 'new-pw-wrap' });
    expect(bloc.getState().recoverable).toBeNull();
    expect(bloc.getState().error).toBeNull();
  });

  it('recoverWithCode surfaces an error and keeps the recovery prompt on a bad code', async () => {
    const { bloc } = buildBloc({
      directory: { getMe: vi.fn(async () => meWithRecovery) } as Partial<DirectoryService>,
      identity: {
        unlock: vi.fn(async () => { throw new Error('wrong password'); }),
        unlockWithRecoveryCode: vi.fn(async () => { throw new Error('tag mismatch'); }),
      } as Partial<IdentityService>,
    });
    await bloc.signIn();
    await bloc.recoverWithCode('wrong-code');
    expect(bloc.getState().error).toMatch(/rejected/i);
    expect(bloc.getState().recoverable).toBe('rec-wrap'); // prompt stays
  });
});

describe('LoginBloc — sign in with a provider', () => {
  const provider = { slug: 'dex', kind: 'oidc', display_name: 'Dex', start_url: 'https://auth.example/v1/sso/dex/start' };
  const session = { access_token: 'a', expires_at: 0, refresh_token: 'r', session_id: 's', user: { id: 'usr_1', username: 'ada', email: null, email_verified: false, role: 'user', user_metadata: {} } };

  function fakeSSO(result: { code?: string; error?: string; errorDescription?: string }): SSOBridge & { opened: string[] } {
    const opened: string[] = [];
    return {
      opened,
      begin: vi.fn(async () => ({ id: 'f1', redirectUri: 'http://127.0.0.1:5555/callback?s=xyz' })),
      wait: vi.fn(async () => result),
      cancel: vi.fn(async () => {}),
      open: vi.fn(async (u: string) => { opened.push(u); }),
    };
  }

  it('shows no providers outside the desktop app', async () => {
    const config = vi.fn(async () => ({ sso_providers: [provider] }));
    const { bloc } = buildBloc({ auth: { config } as never, sso: null });
    await bloc.loadProviders();
    expect(config).not.toHaveBeenCalled();
    expect(bloc.getState().ssoProviders).toEqual([]);
  });

  it('opens the browser with PKCE, exchanges the code and asks for the passphrase of an existing key', async () => {
    const sso = fakeSSO({ code: 'bsc_1' });
    const exchangeSSOCode = vi.fn(async () => session);
    const { bloc, identity } = buildBloc({
      auth: { config: vi.fn(async () => ({ sso_providers: [provider] })), exchangeSSOCode, getState: () => ({ session, loading: false, error: null }) } as never,
      directory: { getMe: vi.fn(async () => ({ encrypted_user_secret: 'blob' })) } as never,
      sso,
    });
    await bloc.loadProviders();
    expect(bloc.getState().ssoProviders).toHaveLength(1);
    await bloc.signInWith('dex');
    const url = new URL(sso.opened[0]!);
    expect(url.origin + url.pathname).toBe(provider.start_url);
    expect(url.searchParams.get('return_to')).toBe('http://127.0.0.1:5555/callback?s=xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = url.searchParams.get('code_challenge')!;
    const [code, verifier] = (exchangeSSOCode.mock.calls[0] as unknown as [string, string]);
    expect(code).toBe('bsc_1');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).toBe(challenge);
    expect(bloc.getState().identityPrompt).toBe('unlock');
    expect(bloc.getState().busy).toBe(false);

    bloc.setPassword('hunter2');
    await bloc.submitIdentityPassphrase();
    expect(identity.unlock).toHaveBeenCalledWith('hunter2', 'blob');
    expect(identity.persist).toHaveBeenCalledWith('usr_1');
    expect(bloc.getState().identityPrompt).toBeNull();
  });

  it('skips the passphrase when the keychain has the key', async () => {
    const { bloc } = buildBloc({
      auth: { config: vi.fn(async () => ({ sso_providers: [provider] })), exchangeSSOCode: vi.fn(async () => session) } as never,
      identity: { restoreFromStorage: vi.fn(async () => true) } as never,
      sso: fakeSSO({ code: 'bsc_1' }),
    });
    await bloc.loadProviders();
    await bloc.signInWith('dex');
    expect(bloc.getState().identityPrompt).toBeNull();
    expect(bloc.getState().error).toBeNull();
  });

  it('makes a key for a new account with a confirmed passphrase', async () => {
    const { bloc, identity } = buildBloc({
      auth: { config: vi.fn(async () => ({ sso_providers: [provider] })), exchangeSSOCode: vi.fn(async () => session) } as never,
      sso: fakeSSO({ code: 'bsc_1' }),
    });
    await bloc.loadProviders();
    await bloc.signInWith('dex');
    expect(bloc.getState().identityPrompt).toBe('create');
    bloc.setPassword('one');
    bloc.setConfirmPassword('two');
    await bloc.submitIdentityPassphrase();
    expect(bloc.getState().error).toMatch(/match/);
    bloc.setConfirmPassword('one');
    await bloc.submitIdentityPassphrase();
    expect(identity.initializeForNewUser).toHaveBeenCalledWith('one');
    expect(bloc.getState().identityPrompt).toBeNull();
  });

  it("shows the provider's error and nothing for a cancel", async () => {
    const h = buildBloc({
      auth: { config: vi.fn(async () => ({ sso_providers: [provider] })), exchangeSSOCode: vi.fn() } as never,
      sso: fakeSSO({ error: 'no_linked_account', errorDescription: 'x' }),
    });
    await h.bloc.loadProviders();
    await h.bloc.signInWith('dex');
    expect(h.bloc.getState().error).toMatch(/No Boson account is linked to that Dex account/);
    expect(h.bloc.getState().busy).toBe(false);

    const c = buildBloc({
      auth: { config: vi.fn(async () => ({ sso_providers: [provider] })) } as never,
      sso: fakeSSO({ error: 'cancelled' }),
    });
    await c.bloc.loadProviders();
    await c.bloc.signInWith('dex');
    expect(c.bloc.getState().error).toBeNull();
  });

  it('backing out of the passphrase signs out', async () => {
    const { bloc, auth } = buildBloc({
      auth: { config: vi.fn(async () => ({ sso_providers: [provider] })), exchangeSSOCode: vi.fn(async () => session) } as never,
      sso: fakeSSO({ code: 'bsc_1' }),
    });
    await bloc.loadProviders();
    await bloc.signInWith('dex');
    await bloc.abandonIdentityPrompt();
    expect(auth.signOut).toHaveBeenCalled();
    expect(bloc.getState().identityPrompt).toBeNull();
  });
});
