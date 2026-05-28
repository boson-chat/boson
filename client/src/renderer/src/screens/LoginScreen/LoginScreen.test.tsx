import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { LoginScreen } from './LoginScreen';
import { AuthProvider } from '../../modules/auth';
import type { AuthService } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { HttpError } from '../../shared/http/http.client';

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

function renderWith(auth: AuthService, directory: DirectoryService, identity: IdentityService) {
  return render(
    <AuthProvider service={auth}>
      <LoginScreen directory={directory} identity={identity} />
    </AuthProvider>
  );
}

describe('LoginScreen', () => {
  it('renders email and password inputs and both buttons', () => {
    renderWith(buildFakeAuth(), buildFakeDirectory(), buildFakeIdentity());
    expect(screen.getByPlaceholderText('email')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign up' })).toBeInTheDocument();
  });

  it('Sign in with no /me row initializes a new identity (signup-style)', async () => {
    const signIn = vi.fn(async () => {});
    const getMe = vi.fn(async () => null);
    const initializeForNewUser = vi.fn(async () => 'b64');

    const auth = buildFakeAuth({ signIn });
    const directory = buildFakeDirectory({ getMe } as Partial<DirectoryService>);
    const identity = buildFakeIdentity({ initializeForNewUser } as Partial<IdentityService>);
    renderWith(auth, directory, identity);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'alice@test.dev');
    await user.type(screen.getByPlaceholderText('password'), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledWith('alice@test.dev', 'secret123');
      expect(initializeForNewUser).toHaveBeenCalledWith('secret123');
    });
  });

  it('Sign in with an existing /me row unlocks the identity', async () => {
    const me = { id: 'u', handle: 'alice', is_discoverable: true, encrypted_user_secret: 'stored-b64', created_at: '' };
    const getMe = vi.fn(async () => me);
    const unlock = vi.fn(async () => {});

    const directory = buildFakeDirectory({ getMe } as Partial<DirectoryService>);
    const identity = buildFakeIdentity({ unlock } as Partial<IdentityService>);
    renderWith(buildFakeAuth(), directory, identity);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'alice@test.dev');
    await user.type(screen.getByPlaceholderText('password'), 'secret123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(unlock).toHaveBeenCalledWith('secret123', 'stored-b64');
    });
  });

  it('shows Start-fresh button when stored blob is unrecoverable (too short)', async () => {
    const me = { id: 'u', handle: 'alice', is_discoverable: true, encrypted_user_secret: 'YWJjZA==', created_at: '' };
    const deleteMe = vi.fn(async () => {});
    const initializeForNewUser = vi.fn(async () => 'new-blob');
    const directory = buildFakeDirectory({
      getMe: vi.fn(async () => me),
      deleteMe,
    } as Partial<DirectoryService>);
    const identity = buildFakeIdentity({
      unlock: vi.fn(async () => { throw new Error('encrypted_user_secret: blob too short'); }),
      initializeForNewUser,
    } as Partial<IdentityService>);
    renderWith(buildFakeAuth(), directory, identity);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'alice@test.dev');
    await user.type(screen.getByPlaceholderText('password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Start fresh to recreate it/)).toBeInTheDocument();
    const startBtn = screen.getByRole('button', { name: 'Start fresh' });
    await user.click(startBtn);

    await waitFor(() => {
      expect(deleteMe).toHaveBeenCalledOnce();
      expect(initializeForNewUser).toHaveBeenCalledWith('pw');
    });
  });

  it('non-blob-too-short unlock errors do NOT show the Start-fresh button', async () => {
    const me = { id: 'u', handle: 'alice', is_discoverable: true, encrypted_user_secret: 'longvalidlookingblob', created_at: '' };
    const directory = buildFakeDirectory({ getMe: vi.fn(async () => me) } as Partial<DirectoryService>);
    const identity = buildFakeIdentity({
      unlock: vi.fn(async () => { throw new Error('OperationError: decrypt failed'); }),
    } as Partial<IdentityService>);
    renderWith(buildFakeAuth(), directory, identity);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'alice@test.dev');
    await user.type(screen.getByPlaceholderText('password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Couldn't decrypt your identity key/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull();
  });

  it('shows a friendly error if unlock fails (wrong password)', async () => {
    const me = { id: 'u', handle: 'alice', is_discoverable: true, encrypted_user_secret: 'stored-b64', created_at: '' };
    const directory = buildFakeDirectory({ getMe: vi.fn(async () => me) } as Partial<DirectoryService>);
    const identity = buildFakeIdentity({
      unlock: vi.fn(async () => { throw new Error('bad password'); }),
    } as Partial<IdentityService>);
    renderWith(buildFakeAuth(), directory, identity);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'alice@test.dev');
    await user.type(screen.getByPlaceholderText('password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Couldn't decrypt your identity key/)).toBeInTheDocument();
  });

  it('Sign up calls signUp and then shows the "Check your email" panel', async () => {
    const signUp = vi.fn(async () => {});
    const initializeForNewUser = vi.fn(async () => 'b64');
    const auth = buildFakeAuth({ signUp });
    const identity = buildFakeIdentity({ initializeForNewUser } as Partial<IdentityService>);
    renderWith(auth, buildFakeDirectory(), identity);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'bob@test.dev');
    await user.type(screen.getByPlaceholderText('password'), 'secret456');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));

    await waitFor(() => {
      expect(signUp).toHaveBeenCalledWith('bob@test.dev', 'secret456');
    });
    // Identity is NOT minted here — we wait for the post-confirmation
    // sign-in to do it (when we'll have a real user_id to persist
    // under). See LoginBloc.signUp for the longer explanation.
    expect(initializeForNewUser).not.toHaveBeenCalled();
    // The form gives way to the awaiting-confirmation panel with the
    // email address called out so the user can sanity-check it.
    expect(await screen.findByText(/Check your email\./i)).toBeInTheDocument();
    expect(screen.getByText('bob@test.dev')).toBeInTheDocument();
  });

  it('shows the error message when sign-in rejects', async () => {
    const auth = buildFakeAuth({
      signIn: vi.fn(async () => { throw new Error('Invalid login credentials'); }),
    });
    renderWith(auth, buildFakeDirectory(), buildFakeIdentity());

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'a@b');
    await user.type(screen.getByPlaceholderText('password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid login credentials')).toBeInTheDocument();
  });

  it('treats getMe 404 as needs-setup and initializes a new identity', async () => {
    const getMe = vi.fn(async () => { throw new HttpError(404, 'needs_setup'); });
    const initializeForNewUser = vi.fn(async () => 'b64');
    const directory = buildFakeDirectory({ getMe } as Partial<DirectoryService>);
    const identity = buildFakeIdentity({ initializeForNewUser } as Partial<IdentityService>);
    renderWith(buildFakeAuth(), directory, identity);

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'a@b');
    await user.type(screen.getByPlaceholderText('password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(initializeForNewUser).toHaveBeenCalled();
    });
  });
});
