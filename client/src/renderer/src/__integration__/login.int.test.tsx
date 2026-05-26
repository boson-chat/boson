import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { FakeAuthService, jsonResponse, mockFetch, mountLogin } from './helpers';

// End-to-end happy-path + wrong-password coverage for the sign-in flow.
// Exercises the real LoginBloc + real IdentityService + real DirectoryService
// (over a real HttpClient hitting a mocked fetch). Only AuthService is faked
// at the structural-interface boundary, since the real one wraps Supabase.

describe('login integration', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => { restoreFetch = null; });
  afterEach(() => { restoreFetch?.(); });

  it('sign-in happy path: unlocks identity and clears any error banner', async () => {
    // The "/me" call returns a previously-stored encrypted blob — but the
    // bloc only attempts unlock if `encrypted_user_secret` is non-empty.
    // For the happy path here, return null so the bloc takes the
    // initializeForNewUser branch, which always succeeds and unlocks.
    restoreFetch = mockFetch({
      'GET /me': () => jsonResponse(null, 404),
    });
    const { auth, identity } = mountLogin();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'alice@boson.dev');
    await user.type(screen.getByPlaceholderText('password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The bloc chains auth.signIn → directory.getMe (404 → null) →
    // identity.initializeForNewUser. After that, identity is unlocked and
    // no error banner appears.
    await waitFor(() => {
      expect(identity.isUnlocked()).toBe(true);
    });

    expect(auth.signInCalls).toEqual([{ email: 'alice@boson.dev', password: 'hunter2' }]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('wrong-password path: shows friendly error and leaves identity locked', async () => {
    // Pretend /me returns a stored blob. Then provide an unlock failure by
    // making sure the password doesn't match. Easiest: hand the bloc a real
    // ciphertext from initializeForNewUser, then sign in with the WRONG
    // password — the identity service's AES-GCM tag check will fail.
    const setup = await import('../modules/identity').then(async (m) => {
      const id = new m.IdentityService((pw, salt) => {
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i++) out[i] = (pw.charCodeAt(i % pw.length) + salt[i]!) & 0xff;
        return out;
      });
      const blob = await id.initializeForNewUser('correct-password');
      return { blob };
    });
    restoreFetch = mockFetch({
      'GET /me': () => jsonResponse({
        id: 'u1', handle: 'alice', is_discoverable: true,
        encrypted_user_secret: setup.blob, created_at: '2026-01-01',
      }),
    });
    // Use a fresh IdentityService for the LoginBloc so the unlock attempt
    // actually has to derive from the password we type.
    const { identity } = mountLogin();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'alice@boson.dev');
    await user.type(screen.getByPlaceholderText('password'), 'WRONG-pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // The bloc surfaces the unlock failure with the canonical user-facing
    // copy. Identity stays locked.
    expect(await screen.findByText(/Couldn't decrypt your identity key/)).toBeInTheDocument();
    expect(identity.isUnlocked()).toBe(false);
  });

  it('surfaces an auth error when signIn rejects', async () => {
    const auth = new FakeAuthService({ signInError: new Error('Invalid login credentials') });
    restoreFetch = mockFetch({});
    mountLogin({ auth });

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'a@b');
    await user.type(screen.getByPlaceholderText('password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid login credentials')).toBeInTheDocument();
  });
});
