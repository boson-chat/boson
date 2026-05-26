import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoginBloc, type LoginState } from './LoginBloc';
import type { AuthService } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { HttpError } from '../../shared/http/http.client';

// Test doubles: fake services with mocked-out methods that the bloc exercises.
// We deliberately type them as the public service interfaces so the bloc sees
// the same shape it would in production.

function buildFakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  const base = {
    signIn: vi.fn(async () => {}),
    signUp: vi.fn(async () => {}),
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
} = {}): Harness {
  const auth = buildFakeAuth(opts.auth);
  const directory = buildFakeDirectory(opts.directory);
  const identity = buildFakeIdentity(opts.identity);
  const bloc = new LoginBloc({ auth, directory, identity });
  return { auth, directory, identity, bloc };
}

describe('LoginBloc', () => {
  describe('initial state', () => {
    it('starts in login mode with empty fields and no errors', () => {
      const { bloc } = buildBloc();
      const s = bloc.getState();
      expect(s).toEqual<LoginState>({
        mode: 'login',
        email: '',
        password: '',
        confirmPassword: '',
        busy: false,
        error: null,
        unrecoverable: null,
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
      bloc.setEmail('alice@test.dev');
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
      bloc.setEmail('alice@test.dev');
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
      bloc.setEmail('alice@test.dev');
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
      bloc.setEmail('alice@test.dev');
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
      bloc.setEmail('alice@test.dev');
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
      bloc.setEmail('alice@test.dev');
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
      bloc.setEmail('a@b');
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

      bloc.setEmail('a@b');
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
    it('happy path calls auth.signUp then identity.initializeForNewUser with the same password', async () => {
      const { bloc, auth, identity } = buildBloc();
      bloc.setEmail('bob@test.dev');
      bloc.setPassword('secret456');
      await bloc.signUp();

      expect(auth.signUp).toHaveBeenCalledWith('bob@test.dev', 'secret456');
      expect(identity.initializeForNewUser).toHaveBeenCalledWith('secret456');
      expect(bloc.getState().busy).toBe(false);
      expect(bloc.getState().error).toBeNull();
    });

    it("emits a Passwords don't match error when confirm differs", async () => {
      const { bloc, auth } = buildBloc();
      bloc.setMode('signup');
      bloc.setEmail('bob@test.dev');
      bloc.setPassword('a');
      bloc.setConfirmPassword('b');
      await bloc.signUp();

      expect(auth.signUp).not.toHaveBeenCalled();
      expect(bloc.getState().error).toBe("Passwords don't match.");
    });

    it('auth.signUp rejection surfaces the error', async () => {
      const { bloc } = buildBloc({
        auth: { signUp: vi.fn(async () => { throw new Error('email already registered'); }) } as Partial<AuthService>,
      });
      bloc.setPassword('pw');
      await bloc.signUp();

      expect(bloc.getState().error).toBe('email already registered');
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
