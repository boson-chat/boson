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

// Full sign-up → directory → setup-prompt → save loop. The post-signup
// SetupPrompt is what stitches the user's chosen handle to the pending
// encrypted_user_secret the IdentityService just produced.

describe('sign-up + setup prompt integration', () => {
  let restoreFetch: (() => void) | null = null;
  afterEach(() => { restoreFetch?.(); restoreFetch = null; });

  it('sign-up → DirectoryScreen → SetupPrompt visible, then Save dismisses it', async () => {
    // Routes serve a two-phase server experience:
    //  - before setup: /me returns 404 (needs_setup)
    //  - after setup: /me returns the new user (we just track it imperatively)
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

    // Step 1: sign up via LoginScreen. The bloc calls auth.signUp +
    // identity.initializeForNewUser; on success the router would normally
    // transition to DirectoryScreen — for this test we drive the transition
    // manually by remounting the same identity/services into DirectoryScreen.
    const auth = new FakeAuthService();
    const identity = makeIdentity();
    const http = new HttpClient('http://api.test', { getToken: () => auth.getToken() });
    const directory = new DirectoryService(http);

    const login = render(
      <AuthProvider service={asAuthService(auth)}>
        <LoginScreen directory={directory} identity={identity} />
      </AuthProvider>
    );

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'newuser@boson.dev');
    await user.type(screen.getByPlaceholderText('password'), 'first-password');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));

    await waitFor(() => {
      expect(identity.isUnlocked()).toBe(true);
      expect(identity.getPendingEncrypted()).not.toBeNull();
    });
    login.unmount();

    // Step 2: render DirectoryScreen. With a real auth session in place,
    // /me returns 404 → SetupPrompt appears.
    auth._setSession({
      access_token: 'jwt', token_type: 'bearer', expires_in: 3600, refresh_token: 'r',
      user: { id: 'u1', email: 'newuser@boson.dev' } as unknown as Session['user'],
    } as unknown as Session);
    const dir = render(
      <AuthProvider service={asAuthService(auth)}>
        <DirectoryScreen directory={directory} engine={null} identity={identity} />
      </AuthProvider>
    );

    expect(await screen.findByText('Finish setting up your account')).toBeInTheDocument();

    // Step 3: fill handle + Save. POST /me is hit; on success the prompt
    // disappears (the bloc updates `me` and the prompt's `me === null` guard
    // flips).
    await user.type(screen.getByPlaceholderText('handle'), 'alice');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByText('Finish setting up your account')).toBeNull();
    });
    // And we cleared the in-memory pending blob since it's now persisted.
    expect(identity.getPendingEncrypted()).toBeNull();
    dir.unmount();
  });
});
