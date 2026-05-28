import { describe, it, expect, afterEach } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../modules/auth';
import { DirectoryService } from '../modules/directory';
import { DirectoryScreen } from '../screens/DirectoryScreen';
import { HttpClient } from '../shared/http/http.client';
import { LoginScreen } from '../screens/LoginScreen';
import { asAuthService, FakeAuthService, jsonResponse, makeIdentity, mockFetch } from './helpers';

// Two-part end-to-end coverage of the post-Supabase-email-confirm flow.
//
// 1. SignUp pauses the LoginScreen on the "Check your email" panel —
//    Supabase has issued the user but no session exists yet, and we
//    deliberately don't mint the local identity until the first
//    post-confirmation sign-in has a real user_id to persist under.
// 2. When the user comes back (deep-link or fresh sign-in) and lands
//    in DirectoryScreen with a session but no /me row, the SetupPrompt
//    renders as the ONLY content (replacing the directory). Saving a
//    handle creates the row and the directory comes back.

describe('sign-up + setup prompt integration', () => {
  let restoreFetch: (() => void) | null = null;
  afterEach(() => { restoreFetch?.(); restoreFetch = null; });

  it('Sign up pauses the LoginScreen on "Check your email" with the address rendered', async () => {
    const auth = new FakeAuthService();
    const identity = makeIdentity();
    const http = new HttpClient('http://api.test', { getToken: () => auth.getToken() });
    const directory = new DirectoryService(http);

    render(
      <AuthProvider service={asAuthService(auth)}>
        <LoginScreen directory={directory} identity={identity} />
      </AuthProvider>
    );

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'newuser@boson.dev');
    await user.type(screen.getByPlaceholderText('password'), 'first-password');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));

    expect(await screen.findByText(/Check your email\./i)).toBeInTheDocument();
    expect(screen.getByText('newuser@boson.dev')).toBeInTheDocument();
    // Identity stays untouched until a real sign-in produces a user_id.
    // Persisting an encrypted secret keyed on "<no user>" wouldn't be
    // useful anyway, so the bloc deliberately defers the mint.
    expect(identity.isUnlocked()).toBe(false);
    expect(identity.getPendingEncrypted()).toBeNull();
  });

  it('When DirectoryScreen mounts with no /me row, SetupPrompt is the only thing rendered', async () => {
    let createdUser: { id: string; handle: string; encrypted_user_secret: string } | null = null;
    restoreFetch = mockFetch({
      'GET /me': () => createdUser
        ? jsonResponse({
            ...createdUser, is_discoverable: true, created_at: '2026-01-01',
          })
        : jsonResponse({ error: 'needs_setup' }, 404),
      'GET /servers': () => jsonResponse({ servers: [], count: 0 }),
      'POST /me': async (init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        createdUser = { id: 'u1', handle: body.handle, encrypted_user_secret: body.encrypted_user_secret };
        return jsonResponse({
          ...createdUser, is_discoverable: true, created_at: '2026-01-01',
        });
      },
    });

    const auth = new FakeAuthService();
    const identity = makeIdentity();
    // Mint the identity directly — in real life, the first post-confirm
    // sign-in does this via the LoginBloc.signIn flow's
    // "encrypted_user_secret missing → initializeForNewUser" branch.
    await identity.initializeForNewUser('first-password');
    const http = new HttpClient('http://api.test', { getToken: () => auth.getToken() });
    const directory = new DirectoryService(http);

    auth._setSession({
      access_token: 'jwt', token_type: 'bearer', expires_in: 3600, refresh_token: 'r',
      user: { id: 'u1', email: 'newuser@boson.dev' } as unknown as Session['user'],
    } as unknown as Session);

    render(
      <AuthProvider service={asAuthService(auth)}>
        <DirectoryScreen directory={directory} engine={null} identity={identity} />
      </AuthProvider>
    );

    // SetupPrompt is the only meaningful content on screen. The
    // directory header / search / filters do NOT render until /me is
    // satisfied.
    expect(await screen.findByText('Finish setting up your account')).toBeInTheDocument();
    expect(screen.queryByText('Server Directory')).toBeNull();
    expect(screen.queryByPlaceholderText('Search servers…')).toBeNull();

    // Save → POST /me → bloc.setMe → setup-stage swap to the real
    // directory.
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('handle'), 'alice');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByText('Finish setting up your account')).toBeNull();
    });
    expect(screen.getByText('Server Directory')).toBeInTheDocument();
    expect(identity.getPendingEncrypted()).toBeNull();
  });
});
