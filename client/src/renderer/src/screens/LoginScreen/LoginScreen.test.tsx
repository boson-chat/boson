import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { LoginScreen } from './LoginScreen';
import { AuthProvider } from '../../modules/auth';
import type { AuthService } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { HttpError } from '../../shared/http/http.client';
import { setHomeNetwork } from '../../modules/netauth/home-network';

function buildFakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  const base = {
    signIn: vi.fn(async () => {}),
    signUp: vi.fn(async () => ({ verificationRequired: true })),
    requestPasswordReset: vi.fn(async () => {}),
    resendVerification: vi.fn(async () => {}),
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
  it('renders login and password inputs and only the active tab\'s button', async () => {
    renderWith(buildFakeAuth(), buildFakeDirectory(), buildFakeIdentity());
    expect(screen.getByPlaceholderText('username or email')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign up' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Signup' }));
    expect(screen.getByRole('button', { name: 'Sign up' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  // The login screen says what Boson is for; identity-key details are for
  // Settings, not the sign-in form.
  it('leads with what Boson is, not IRC or identity keys', () => {
    renderWith(buildFakeAuth(), buildFakeDirectory(), buildFakeIdentity());
    expect(screen.getByText(/Chat, voice and video with your communities/)).toBeInTheDocument();
    expect(screen.queryByText(/IRC, modernized/i)).toBeNull();
    expect(screen.queryByText(/identity key/i)).toBeNull();
    expect(screen.queryByText(/keychain/i)).toBeNull();
  });

  it('shows sign-up rules up front and problems next to their fields on blur', async () => {
    renderWith(buildFakeAuth(), buildFakeDirectory(), buildFakeIdentity());
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Signup' }));
    expect(screen.getByText('At least 10 characters.')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('password'), 'short');
    await user.tab();
    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('password'), ' and longer');
    expect(screen.queryByText('Use at least 10 characters.')).toBeNull();
  });

  it('guest mode is its own step with a Back link', async () => {
    renderWith(buildFakeAuth(), buildFakeDirectory(), buildFakeIdentity());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue without an account' }));
    expect(screen.getByRole('heading', { name: 'Continue as a guest' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('username or email')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText(/stay on this device only/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByPlaceholderText('username or email')).toBeInTheDocument();
  });

  it("says when the app's own network takes no guests: boson.chat", async () => {
    renderWith(buildFakeAuth({ config: vi.fn(async () => ({ sso_providers: [], guest_access: false })) } as Partial<AuthService>), buildFakeDirectory(), buildFakeIdentity());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue without an account' }));
    expect(await screen.findByText(/boson\.chat itself needs an account/)).toBeInTheDocument();
  });

  it("says when the app's own network takes no guests: a self-hosted web client's", async () => {
    setHomeNetwork({ domain: 'boson.example.org', name: 'Example', selfHosted: true });
    try {
      renderWith(buildFakeAuth({ config: vi.fn(async () => ({ sso_providers: [], guest_access: false })) } as Partial<AuthService>), buildFakeDirectory(), buildFakeIdentity());
      await userEvent.setup().click(screen.getByRole('button', { name: 'Continue without an account' }));
      expect(await screen.findByText(/Example itself needs an account/)).toBeInTheDocument();
      expect(screen.queryByText(/boson\.chat/)).toBeNull();
    } finally {
      setHomeNetwork(null);
    }
  });

  it('says why when the session ended on its own', () => {
    const auth = buildFakeAuth({
      getState: vi.fn(() => ({ session: null, loading: false, error: null, signedOutReason: 'expired' as const })),
      subscribe: vi.fn((fn: (s: unknown) => void) => { fn({ session: null, loading: false, error: null, signedOutReason: 'expired' }); return () => {}; }) as unknown as AuthService['subscribe'],
    });
    renderWith(auth, buildFakeDirectory(), buildFakeIdentity());
    expect(screen.getByText(/You were signed out/)).toBeInTheDocument();
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
    await user.type(screen.getByPlaceholderText('username or email'), 'alice@test.dev');
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
    await user.type(screen.getByPlaceholderText('username or email'), 'alice@test.dev');
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
    await user.type(screen.getByPlaceholderText('username or email'), 'alice@test.dev');
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
    await user.type(screen.getByPlaceholderText('username or email'), 'alice@test.dev');
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
    await user.type(screen.getByPlaceholderText('username or email'), 'alice@test.dev');
    await user.type(screen.getByPlaceholderText('password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Couldn't decrypt your identity key/)).toBeInTheDocument();
  });

  it('Sign up calls signUp and then shows the "Check your email" panel', async () => {
    const signUp = vi.fn(async () => ({ verificationRequired: true }));
    const initializeForNewUser = vi.fn(async () => 'b64');
    const auth = buildFakeAuth({ signUp });
    const identity = buildFakeIdentity({ initializeForNewUser } as Partial<IdentityService>);
    renderWith(auth, buildFakeDirectory(), identity);

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Signup' }));
    await user.type(screen.getByPlaceholderText('username'), 'bob');
    await user.type(screen.getByPlaceholderText('email'), 'bob@test.dev');
    await user.type(screen.getByPlaceholderText('password'), 'secret456789');
    await user.type(screen.getByPlaceholderText('confirm password'), 'secret456789');
    expect(signUp).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign up' }));

    await waitFor(() => {
      expect(signUp).toHaveBeenCalledWith({ username: 'bob', email: 'bob@test.dev', password: 'secret456789' });
    });
    // Identity is NOT minted here — the sign-in after verification
    // does it. See LoginBloc.signUp.
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
    await user.type(screen.getByPlaceholderText('username or email'), 'a@b');
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
    await user.type(screen.getByPlaceholderText('username or email'), 'a@b');
    await user.type(screen.getByPlaceholderText('password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(initializeForNewUser).toHaveBeenCalled();
    });
  });

  it('shows live username feedback on the sign-up form', async () => {
    renderWith(buildFakeAuth(), buildFakeDirectory(), buildFakeIdentity());
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Signup' }).closest('button') ?? screen.getByText('Signup'));
    await user.type(screen.getByPlaceholderText('username'), 'my nick');
    expect(await screen.findByText('No spaces.')).toBeInTheDocument();
  });

  it('Forgot password? sends a reset link', async () => {
    const requestPasswordReset = vi.fn(async () => {});
    renderWith(buildFakeAuth({ requestPasswordReset }), buildFakeDirectory(), buildFakeIdentity());
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('username or email'), 'alice@test.dev');
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByPlaceholderText('email')).toHaveValue('alice@test.dev');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    await waitFor(() => expect(requestPasswordReset).toHaveBeenCalledWith('alice@test.dev'));
    expect(await screen.findByText(/a reset link is on its way/)).toBeInTheDocument();
  });
});
