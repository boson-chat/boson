import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from '../app';
import { AccountDirectory } from '../modules/directory/account-directory';
import type { ChatHistoryStore } from '../modules/history';
import { IdentityService } from '../modules/identity';
import type { Session } from '../modules/auth';
import { InMemorySecureStorage } from '../shared/secure-storage';
import { HttpClient } from '../shared/http/http.client';
import { requestIdentityKey, resetKeyRequests } from '../modules/identity/key-request';
import { FakeAuthService, asAuthService, jsonResponse } from './helpers';

// "Sign in with IRCForever" (an identity provider, SSO): no password was
// typed and the account may have none, so the app opens without an
// identity key step, like a federated sign-in. The key is this account's
// own, asked for when something needs it.

const kdf = (pw: string, salt: Uint8Array): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (pw.charCodeAt(i % Math.max(pw.length, 1)) + salt[i]!) & 0xff;
  return out;
};

const ssoSession = {
  access_token: 'sso-token', token_type: 'bearer', expires_in: 3600, refresh_token: 'r',
  user: { id: 'u-admin', username: 'admin', email: 'admin@example.com', email_verified: true, role: 'user' },
  sso: { provider: 'IRCForever' },
} as unknown as Session;

const passwordSession = { ...ssoSession, sso: undefined } as unknown as Session;

interface Call { method: string; path: string; body: unknown }

// This server's API. me: the /me row (null: not set up yet). Records calls.
function fakeApi(opts: { me: Record<string, unknown> | null; keylessSetup?: boolean }) {
  const calls: Call[] = [];
  let me = opts.me;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/me' && method === 'GET') return me ? jsonResponse(me) : jsonResponse({ status: 'needs_setup' }, 404);
    if (url.pathname === '/me' && method === 'POST') {
      if (!body?.['encrypted_user_secret'] && !opts.keylessSetup) return jsonResponse({ error: 'encrypted_user_secret is required' }, 400);
      me = { id: 'u-admin', handle: body!['handle'], is_discoverable: true, created_at: '2026-01-01', encrypted_user_secret: body!['encrypted_user_secret'] ?? '' };
      return jsonResponse(me, 201);
    }
    if (url.pathname === '/me/secret-wraps' && method === 'PUT') {
      me = { ...me!, ...(body!['encrypted_user_secret'] ? { encrypted_user_secret: body!['encrypted_user_secret'] } : {}), ...(body!['encrypted_user_secret_recovery'] ? { encrypted_user_secret_recovery: body!['encrypted_user_secret_recovery'] } : {}) };
      return jsonResponse(me);
    }
    if (url.pathname === '/me/session') return jsonResponse({ payload: { servers: [] } });
    if (url.pathname === '/me/nickserv-secrets') return jsonResponse({ secrets: [] });
    if (url.pathname === '/me/bouncer') return jsonResponse({ bouncer: null });
    if (url.pathname === '/servers') return jsonResponse({ servers: [] });
    if (url.pathname === '/config') return jsonResponse({ nick_claim: true });
    return jsonResponse({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { calls, me: () => me, restore: () => { globalThis.fetch = previous; } };
}

function mount(auth: FakeAuthService, keychain: InMemorySecureStorage) {
  const identity = new IdentityService(kdf, keychain);
  const directory = new AccountDirectory(new HttpClient('http://api.test', { getToken: () => auth.getToken() }), asAuthService(auth));
  const r = render(
    <App
      auth={asAuthService(auth)}
      directory={directory}
      engine={null}
      identity={identity}
      history={{} as ChatHistoryStore}
      homeData={directory.homeData}
    />,
  );
  return { identity, directory, unmount: () => r.unmount() };
}

async function blob(passphrase: string): Promise<string> {
  return new IdentityService(kdf, new InMemorySecureStorage()).initializeForNewUser(passphrase);
}

const existing = async (pw: string) => ({
  id: 'u-admin', handle: 'admin', is_discoverable: true, created_at: '2026-01-01', encrypted_user_secret: await blob(pw),
});

let api: ReturnType<typeof fakeApi> | null = null;
beforeEach(() => { localStorage.clear(); resetKeyRequests(); });
afterEach(() => { cleanup(); api?.restore(); api = null; resetKeyRequests(); });

describe('an SSO session', () => {
  it('an existing account with a password-wrapped key reaches the app: no "Unlock your identity key" gate', async () => {
    api = fakeApi({ me: await existing('admin password') });
    const { identity } = mount(new FakeAuthService({ session: ssoSession }), new InMemorySecureStorage());
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText(/Unlock your identity key/)).toBeNull();
    expect(screen.queryByText(/protected by your Boson password/)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(identity.isUnlocked()).toBe(false);
    await waitFor(() => expect(screen.getByRole('button', { name: 'User settings' }).textContent).toContain('admin'));
  });

  it('the key is asked for later, saying why; the Boson password unlocks it and it stays on this device', async () => {
    api = fakeApi({ me: await existing('admin password') });
    const keychain = new InMemorySecureStorage();
    const { identity, unmount } = mount(new FakeAuthService({ session: ssoSession }), keychain);
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();

    let asked!: Promise<boolean>;
    act(() => { asked = requestIdentityKey(identity, 'nickserv'); });
    const field = await screen.findByLabelText('Password or passphrase');
    expect(screen.getByRole('dialog').textContent).toContain('You signed in with IRCForever');
    expect(screen.getByRole('dialog').textContent).toContain('NickServ password');

    fireEvent.input(field, { target: { value: 'wrong one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(identity.isUnlocked()).toBe(false);

    fireEvent.input(screen.getByLabelText('Password or passphrase'), { target: { value: 'admin password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await asked).toBe(true);
    expect(identity.isUnlocked()).toBe(true);
    unmount();

    // A reload: unlocked from this device, no prompt.
    const again = mount(new FakeAuthService({ session: ssoSession }), keychain);
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    await waitFor(() => expect(again.identity.isUnlocked()).toBe(true));
  });

  it('"Not now" closes it and the app goes on', async () => {
    api = fakeApi({ me: await existing('admin password') });
    const { identity } = mount(new FakeAuthService({ session: ssoSession }), new InMemorySecureStorage());
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    let asked!: Promise<boolean>;
    act(() => { asked = requestIdentityKey(identity, 'bouncer'); });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(await asked).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await requestIdentityKey(identity, 'bouncer')).toBe(false);
  });

  it('a new SSO account picks only a handle; its key is set up when needed, at this server', async () => {
    api = fakeApi({ me: null, keylessSetup: true });
    const { identity } = mount(new FakeAuthService({ session: ssoSession }), new InMemorySecureStorage());
    const handle = await screen.findByPlaceholderText('handle', {}, { timeout: 2000 });
    expect(screen.queryByPlaceholderText('password')).toBeNull();
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
    fireEvent.input(handle, { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/me');
    expect(post?.body).toMatchObject({ handle: 'admin', encrypted_user_secret: '' });
    expect(identity.isUnlocked()).toBe(false);

    // Later: no key yet, so it's set up (a passphrase, and a recovery code).
    let asked!: Promise<boolean>;
    act(() => { asked = requestIdentityKey(identity, 'bouncer'); });
    const pass = await screen.findByLabelText('Passphrase');
    expect(screen.getByRole('dialog').textContent).toContain("Your account doesn't have one yet");
    fireEvent.input(pass, { target: { value: 'my new passphrase' } });
    fireEvent.input(screen.getByLabelText('Confirm passphrase'), { target: { value: 'my new passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up key' }));
    await waitFor(() => expect(api!.calls.some((c) => c.method === 'PUT' && c.path === '/me/secret-wraps')).toBe(true));
    expect(api.me()?.['encrypted_user_secret']).toBeTruthy();
    expect(api.me()?.['encrypted_user_secret_recovery']).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Continue|saved/i }));
    expect(await asked).toBe(true);
  });

  it('an API that still needs a key at set-up asks for a passphrase on the handle step instead', async () => {
    api = fakeApi({ me: null, keylessSetup: false });
    mount(new FakeAuthService({ session: ssoSession }), new InMemorySecureStorage());
    fireEvent.input(await screen.findByPlaceholderText('handle', {}, { timeout: 2000 }), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const pass = await screen.findByLabelText('Passphrase');
    fireEvent.input(pass, { target: { value: 'my new passphrase' } });
    fireEvent.input(screen.getByLabelText('Confirm passphrase'), { target: { value: 'my new passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api!.me()?.['handle']).toBe('admin'));
    expect(api.me()?.['encrypted_user_secret']).toBeTruthy();
  });

  it('a password session with a locked key still gets the login screen', async () => {
    api = fakeApi({ me: await existing('admin password') });
    mount(new FakeAuthService({ session: passwordSession }), new InMemorySecureStorage());
    await waitFor(() => expect(screen.queryByPlaceholderText('Search servers…')).toBeNull());
    expect(await screen.findByRole('button', { name: /sign in/i }, { timeout: 2000 })).toBeTruthy();
  });
});
