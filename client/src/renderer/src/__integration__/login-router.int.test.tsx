import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { Session } from '@supabase/supabase-js';
import { App } from '../app';
import { DirectoryService } from '../modules/directory';
import type { ChatHistoryStore } from '../modules/history';
import { IdentityService } from '../modules/identity';
import type { SecureStorage } from '../shared/secure-storage';
import { HttpClient } from '../shared/http/http.client';
import { FakeAuthService, asAuthService, jsonResponse, makeIdentity, mockFetch } from './helpers';

// Sign-in through the whole App (Router included), not just LoginScreen:
// the Router reacts to the session that a successful auth.signIn creates
// while the LoginBloc is still unlocking the identity.

// The OS keychain answers over IPC, so the Router's restore-from-keychain
// attempt takes a moment — long enough for its "Restoring session…" shim to
// render. An empty keychain here (nothing to restore).
const slowEmptyKeychain: SecureStorage = {
  isAvailable: () => new Promise((r) => setTimeout(() => r(true), 30)),
  get: async () => null,
  set: async () => {},
  remove: async () => {},
};

function mountApp(auth: FakeAuthService) {
  // Same no-op KDF as makeIdentity(), with the slow keychain.
  const identity = new IdentityService((pw, salt) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = (pw.charCodeAt(i % Math.max(pw.length, 1)) + salt[i]!) & 0xff;
    return out;
  }, slowEmptyKeychain);
  const directory = new DirectoryService(new HttpClient('http://api.test', { getToken: () => auth.getToken() }));
  render(
    <App
      auth={asAuthService(auth)}
      directory={directory}
      engine={null}
      identity={identity}
      history={{} as ChatHistoryStore}
    />,
  );
  return { identity };
}

describe('login through the app router', () => {
  let restoreFetch: (() => void) | null = null;
  afterEach(() => { restoreFetch?.(); restoreFetch = null; });

  // Regression: the session from auth.signIn flipped the Router to its
  // "Restoring session…" shim, unmounting LoginScreen (and its LoginBloc)
  // mid-sign-in. A failed identity unlock then landed on the orphaned bloc:
  // the remounted form showed no error and never offered the recovery code,
  // so a user whose password had been reset could not get back in.
  it('keeps the unlock error and offers the recovery code after a password reset', async () => {
    const seed = makeIdentity();
    const passwordWrap = await seed.initializeForNewUser('old-password');
    const recoveryWrap = seed.getPendingRecovery()!.recoveryBlob;
    restoreFetch = mockFetch({
      'GET /me': () => jsonResponse({
        id: 'u1', handle: 'alice', is_discoverable: true, created_at: '2026-01-01',
        encrypted_user_secret: passwordWrap,
        encrypted_user_secret_recovery: recoveryWrap,
      }),
    });
    const { identity } = mountApp(new FakeAuthService());

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('email'), 'alice@boson.dev');
    await user.type(screen.getByPlaceholderText('password'), 'new-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Let the keychain restore attempt (30ms) and the unlock settle, then
    // check what the user is left looking at.
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByText('Restoring session…')).toBeNull();
    expect(screen.getByText(/enter your recovery code/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx')).toBeInTheDocument();
    expect(identity.isUnlocked()).toBe(false);
  });

  // The confirmation deep link establishes a session while the login screen
  // shows "Check your email." — it must move on to the sign-in form (the
  // identity can only be unlocked with the password).
  it('leaves "Check your email" for the sign-in form once the confirmation session arrives', async () => {
    restoreFetch = mockFetch({});
    const auth = new FakeAuthService();
    mountApp(auth);

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Signup' }));
    await user.type(screen.getByPlaceholderText('email'), 'new@boson.dev');
    await user.type(screen.getByPlaceholderText('password'), 'pw-123456');
    await user.type(screen.getByPlaceholderText('confirm password'), 'pw-123456');
    await user.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('Check your email.')).toBeInTheDocument();

    auth._setSession({
      access_token: 'jwt', token_type: 'bearer', expires_in: 3600, refresh_token: 'r',
      user: { id: 'u1', email: 'new@boson.dev' },
    } as unknown as Session);

    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByRole('tab', { name: 'Login', selected: true })).toBeInTheDocument();
    expect(screen.queryByText('Check your email.')).toBeNull();
    expect(screen.getByPlaceholderText('email')).toHaveValue('new@boson.dev');
  });

  // Launch with a persisted session: the restore shim (not a flash of the
  // login form) covers the keychain lookup; with nothing in the keychain the
  // user then signs in.
  it('shows the restore shim on launch with a saved session, then the sign-in form', async () => {
    restoreFetch = mockFetch({});
    const auth = new FakeAuthService({
      session: {
        access_token: 'jwt', token_type: 'bearer', expires_in: 3600, refresh_token: 'r',
        user: { id: 'u1', email: 'back@boson.dev' },
      } as unknown as Session,
    });
    mountApp(auth);

    expect(await screen.findByText('Restoring session…')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('email')).toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.queryByText('Restoring session…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
