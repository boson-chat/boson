import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { App } from '../app';
import { AccountDirectory } from '../modules/directory/account-directory';
import type { ChatHistoryStore } from '../modules/history';
import { IdentityService } from '../modules/identity';
import type { Session } from '../modules/auth';
import { InMemorySecureStorage } from '../shared/secure-storage';
import { HttpClient } from '../shared/http/http.client';
import { setHomeAuthSource } from '../modules/netauth/home-account';
import { requestIdentityKey, resetKeyRequests } from '../modules/identity/key-request';
import { FakeAuthService, asAuthService, jsonResponse } from './helpers';

// A federated sign-in ("Continue as alice@boson.chat" on a self-hosted web
// client) goes straight into the app, and the home account (boson.chat) is
// where the account's data comes from. The identity key is the home's,
// asked for only when something needs it.

const kdf = (pw: string, salt: Uint8Array): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (pw.charCodeAt(i % Math.max(pw.length, 1)) + salt[i]!) & 0xff;
  return out;
};

const federatedSession = {
  access_token: 'remote-token', token_type: 'bearer', expires_in: 3600, refresh_token: 'r',
  user: { id: 'u-remote', username: 'alice-bosonchat', email: null, email_verified: true, role: 'user' },
  federated: { identity: 'alice@boson.chat', handle: 'alice-bosonchat', homeAuthUrl: 'https://auth.boson.chat', homeDomain: 'boson.chat' },
} as unknown as Session;

const homeSession = {
  access_token: 'home-token', token_type: 'bearer', expires_in: 3600, refresh_token: 'hr',
  user: { id: 'u-home', username: 'alice', email: 'alice@example.com', email_verified: true, role: 'user' },
} as unknown as Session;

interface Call { method: string; host: string; path: string; auth: string | null; body: unknown }

function fakeBackends(opts: { homeBlob: string }) {
  const calls: Call[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({ method, host: url.host, path: url.pathname, auth: headers.get('Authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.host === 'api.boson.chat') {
      if (url.pathname === '/me') {
        return jsonResponse({
          id: 'me-home', handle: 'alice', display_name: 'Alice', avatar_url: 'https://cdn.boson.chat/a.png',
          is_discoverable: true, created_at: '2026-01-01', encrypted_user_secret: opts.homeBlob,
        });
      }
      if (url.pathname === '/me/session') return jsonResponse({ payload: { servers: [] } });
      if (url.pathname === '/me/nickserv-secrets') return jsonResponse({ secrets: [] });
      if (url.pathname === '/me/bouncer') return jsonResponse({ bouncer: null });
    }
    if (url.host === 'api.test' && url.pathname === '/servers') return jsonResponse({ servers: [] });
    if (url.host === 'api.test' && url.pathname === '/config') return jsonResponse({ nick_claim: true });
    return jsonResponse({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = previous; } };
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

async function homeBlob(passphrase: string): Promise<string> {
  return new IdentityService(kdf, new InMemorySecureStorage()).initializeForNewUser(passphrase);
}

let backends: ReturnType<typeof fakeBackends> | null = null;
beforeEach(() => {
  localStorage.clear();
  resetKeyRequests();
  const home = new FakeAuthService({ session: homeSession });
  setHomeAuthSource({ homeAuthFor: async () => asAuthService(home) });
});
afterEach(() => {
  cleanup();
  backends?.restore();
  backends = null;
  setHomeAuthSource(null);
  resetKeyRequests();
});

describe('a federated session', () => {
  it('reaches the app with no identity key step, with its profile from the home account', async () => {
    backends = fakeBackends({ homeBlob: await homeBlob('home passphrase') });
    const { identity } = mount(new FakeAuthService({ session: federatedSession }), new InMemorySecureStorage());

    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText('Unlock your identity key.')).toBeNull();
    expect(screen.queryByText('Set an identity passphrase.')).toBeNull();
    expect(screen.queryByText('Unlock your identity key')).toBeNull();
    expect(identity.isUnlocked()).toBe(false);

    // The profile and the synced session came from boson.chat, with its token.
    await waitFor(() => expect(backends!.calls.some((c) => c.host === 'api.boson.chat' && c.path === '/me')).toBe(true));
    await waitFor(() => expect(backends!.calls.some((c) => c.host === 'api.boson.chat' && c.path === '/me/session')).toBe(true));
    const homeCalls = backends.calls.filter((c) => c.host === 'api.boson.chat');
    expect(homeCalls.every((c) => c.auth === 'Bearer home-token')).toBe(true);
    // Nothing of the account's is read from, or made on, the remote's API.
    const remoteAccount = backends.calls.filter((c) => c.host === 'api.test' && c.path.startsWith('/me'));
    expect(remoteAccount).toEqual([]);
    // The title bar shows the home profile's handle.
    await waitFor(() => expect(screen.getByRole('button', { name: 'User settings' }).textContent).toContain('alice'));
  });

  it('a reload keeps it: straight back into the app, the key unlocked from this device when kept here', async () => {
    backends = fakeBackends({ homeBlob: await homeBlob('home passphrase') });
    const keychain = new InMemorySecureStorage();
    const first = mount(new FakeAuthService({ session: federatedSession }), keychain);
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    first.unmount();

    // Reload, no key kept here: still the app, still locked, no prompt.
    const second = mount(new FakeAuthService({ session: federatedSession }), keychain);
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText('Restoring session…')).toBeNull();
    expect(second.identity.isUnlocked()).toBe(false);
    second.unmount();

    // The home account's key was unlocked here before (kept under its id):
    // a reload unlocks it without asking.
    const seed = new IdentityService(kdf, keychain);
    await seed.initializeForNewUser('home passphrase');
    await seed.persist('u-home');
    const third = mount(new FakeAuthService({ session: federatedSession }), keychain);
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    await waitFor(() => expect(third.identity.isUnlocked()).toBe(true));
    expect(screen.queryByText('Unlock your identity key')).toBeNull();
  });

  it('asks for the home account\'s key when something needs it, and keeps it under the home id', async () => {
    backends = fakeBackends({ homeBlob: await homeBlob('home passphrase') });
    const keychain = new InMemorySecureStorage();
    const { identity } = mount(new FakeAuthService({ session: federatedSession }), keychain);
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();

    let asked!: Promise<boolean>;
    act(() => { asked = requestIdentityKey(identity, 'nickserv'); });
    expect(await screen.findByLabelText('Password or passphrase')).toBeTruthy();
    expect(screen.getByText('Unlock your identity key')).toBeTruthy();
    const body = document.querySelector('.identity-key-prompt-body')!.textContent!;
    expect(body).toContain('NickServ password');
    expect(body).toContain('alice@boson.chat');
    expect(body).toContain('boson.chat');

    fireEvent.input(screen.getByLabelText('Password or passphrase'), { target: { value: 'wrong one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(identity.isUnlocked()).toBe(false);

    fireEvent.input(screen.getByLabelText('Password or passphrase'), { target: { value: 'home passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await asked).toBe(true);
    expect(identity.isUnlocked()).toBe(true);
    expect(await keychain.get('boson.identity.u-home')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Unlock your identity key')).toBeNull());
  });

  it('"Not now" closes it and the same reason doesn\'t ask again this run', async () => {
    backends = fakeBackends({ homeBlob: await homeBlob('home passphrase') });
    const { identity } = mount(new FakeAuthService({ session: federatedSession }), new InMemorySecureStorage());
    expect(await screen.findByPlaceholderText('Search servers…', {}, { timeout: 2000 })).toBeTruthy();
    let asked!: Promise<boolean>;
    act(() => { asked = requestIdentityKey(identity, 'bouncer'); });
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(await asked).toBe(false);
    expect(await requestIdentityKey(identity, 'bouncer')).toBe(false);
    expect(screen.queryByText('Unlock your identity key')).toBeNull();
  });
});

describe('a local account', () => {
  it('still unlocks its key at sign-in: a locked key keeps it on the login screen', async () => {
    backends = fakeBackends({ homeBlob: '' });
    const local = { ...federatedSession, federated: undefined, user: { ...federatedSession.user, id: 'u-local', username: 'bob' } } as unknown as Session;
    mount(new FakeAuthService({ session: local }), new InMemorySecureStorage());
    await waitFor(() => expect(screen.queryByText('Restoring session…')).toBeNull());
    expect(screen.queryByPlaceholderText('Search servers…')).toBeNull();
    expect(backends.calls.some((c) => c.host === 'api.boson.chat')).toBe(false);
  });
});
