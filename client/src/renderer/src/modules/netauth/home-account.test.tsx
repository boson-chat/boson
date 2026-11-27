import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/preact';
import { AuthService } from '../auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { HttpClient } from '../../shared/http/http.client';
import { NetworkAccounts } from './network-accounts';
import { HomeAccountData, HomeUnavailableError, homeApiUrlFor, setHomeAuthSource } from './home-account';
import { AccountDirectory } from '../directory/account-directory';
import { resolveIrcLogin } from './irc-login';
import { setHomeNetwork } from './home-network';
import { clearGuestSession, loadGuestSession } from '../guest/guest';
import { IdentityService } from '../identity';
import { requestIdentityKey, resetKeyRequests } from '../identity/key-request';
import { IdentityKeyPrompt } from '../../components/IdentityKeyPrompt';

// The home account (boson.chat) is the source of truth for a federated
// session's own data; the remote keeps its IRC account.

const REMOTE_AUTH = 'https://auth.boson.ircforever.org';
const BOSON_AUTH = 'https://auth.boson.chat';
const fed = (domain: string) => ({
  version: 1, issuer: `https://auth.${domain}`, accepts: 'directory', domain,
  assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
  login_endpoint: `https://auth.${domain}/v1/federation/login`,
});
const json = (status: number, v: unknown): ApiResponse => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });
const kdf = (pw: string, salt: Uint8Array): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (pw.charCodeAt(i % Math.max(pw.length, 1)) + salt[i]!) & 0xff;
  return out;
};

function setup(opts: { homeMe?: unknown; homeApi?: 'ok' | 'down' } = {}) {
  const sent: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    const headers = (req.headers ?? {}) as Record<string, string>;
    sent.push({ method: req.method ?? 'GET', url: req.url, auth: headers['Authorization'] ?? headers['authorization'] ?? null, body: req.body ? JSON.parse(String(req.body)) : null });
    const tokens = (username: string, extra = {}) => json(200, {
      access_token: `h.e30.${u.host}`, expires_in: 900, refresh_token: `rt-${u.host}`, session_id: 's',
      user: { id: `u-${u.host}`, username, email: null, email_verified: true, role: 'user' }, ...extra,
    });
    if (u.host === 'api.boson.chat') {
      if (opts.homeApi === 'down') throw new TypeError('Failed to fetch');
      if (u.pathname === '/me' && req.method === 'POST') return json(201, { id: 'me', handle: 'alice', encrypted_user_secret: 'x', is_discoverable: true, created_at: '' });
      if (u.pathname === '/me') return opts.homeMe === undefined ? json(404, { status: 'needs_setup' }) : json(200, opts.homeMe);
      if (u.pathname === '/me/session') return json(200, { payload: { servers: [], prefs: {} } });
      return json(204, {});
    }
    if (u.host === 'api.boson.ircforever.org') return json(200, { id: 'remote-me', handle: 'remote', encrypted_user_secret: 'r', is_discoverable: false, created_at: '' });
    if (u.pathname === '/v1/config') return json(200, { registration: 'closed', sso_providers: [] });
    if (u.pathname === '/v1/login') return tokens('alice');
    if (u.pathname === '/v1/federation/assertions') return json(200, { assertion: 'jwt', expires_in: 300 });
    if (u.pathname === '/v1/federation/login') return tokens('alice-bosonchat', { federated: true, identity: 'alice@boson.chat', handle: 'alice-bosonchat' });
    return json(404, {});
  });
  const storage = new InMemorySecureStorage();
  const mainAuth = new AuthService(REMOTE_AUTH, { storage, transport });
  const accounts = new NetworkAccounts({
    mainAuthUrl: REMOTE_AUTH, mainAuth, storage, transport,
    isGuest: () => loadGuestSession() !== null,
    bridge: {
      discover: async (host: string) => (host.endsWith('ircforever.org')
        ? { host, main: true, authUrl: REMOTE_AUTH, federation: fed('boson.ircforever.org') }
        : { host, main: false, authUrl: BOSON_AUTH, federation: fed('boson.chat') }),
    },
  });
  setHomeAuthSource(accounts);
  const homeData = new HomeAccountData(mainAuth, { transport });
  const directory = new AccountDirectory(new HttpClient('https://api.boson.ircforever.org', { getToken: () => mainAuth.getToken() }, transport), mainAuth, homeData);
  return { accounts, mainAuth, storage, sent, transport, homeData, directory };
}

// "Continue as alice@boson.chat" on the sign-in screen: boson.chat signed
// in here, then the main account federated from it.
async function federatedMain(s: ReturnType<typeof setup>) {
  await s.mainAuth.init();
  await s.accounts.discover('irc.boson.chat');
  await s.accounts.service(BOSON_AUTH).signIn('alice', 'pw');
  const remote = (await s.accounts.discover('irc.boson.ircforever.org'))!;
  const [h] = await s.accounts.homeAccounts(remote);
  await s.accounts.signInFederated(remote, h!);
  return remote;
}

beforeEach(() => {
  localStorage.clear();
  resetKeyRequests();
  setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRCForever', selfHosted: true, irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true } });
});
afterEach(() => { cleanup(); clearGuestSession(); setHomeNetwork(null); setHomeAuthSource(null); resetKeyRequests(); });

describe('homeApiUrlFor', () => {
  it('is the auth service\'s api sibling', () => {
    expect(homeApiUrlFor('https://auth.boson.chat')).toBe('https://api.boson.chat');
    expect(homeApiUrlFor('https://auth.boson.ircforever.org/')).toBe('https://api.boson.ircforever.org');
    expect(homeApiUrlFor('http://auth.localhost:8080')).toBe('http://api.localhost:8080');
    expect(homeApiUrlFor('https://login.example.org')).toBeNull();
    expect(homeApiUrlFor('https://auth.org')).toBeNull();
    expect(homeApiUrlFor('nope')).toBeNull();
  });
});

describe('a federated session\'s account data comes from the home account', () => {
  it('signs the main account in federated, with the home account still signed in beside it', async () => {
    const s = setup({ homeMe: { id: 'me-home', handle: 'alice', avatar_url: 'https://cdn/a.png', encrypted_user_secret: 'blob', is_discoverable: true, created_at: '' } });
    await federatedMain(s);
    expect(s.mainAuth.getState().session?.federated?.identity).toBe('alice@boson.chat');
    const home = await s.homeData.home();
    expect(home?.userId).toBe('u-auth.boson.chat');
    expect(home?.identity).toBe('alice@boson.chat');
  });

  it('profile, saved session, NickServ and bouncer secrets go to api.boson.chat with the home token', async () => {
    const s = setup({ homeMe: { id: 'me-home', handle: 'alice', avatar_url: 'https://cdn/a.png', encrypted_user_secret: 'blob', is_discoverable: true, created_at: '' } });
    await federatedMain(s);
    s.sent.length = 0;
    const me = await s.directory.getMe();
    expect(me).toMatchObject({ handle: 'alice', avatar_url: 'https://cdn/a.png', encrypted_user_secret: 'blob' });
    await s.directory.getSavedSession();
    await s.directory.putSavedSession({ servers: [] });
    await s.directory.putNickservSecret('srv', 'ct');
    await s.directory.putBouncer('ct');
    await s.directory.updateSecretWraps({ recoveryBlob: 'r' });
    expect(s.sent.map((r) => new URL(r.url).host)).toEqual(Array(6).fill('api.boson.chat'));
    expect(s.sent.every((r) => r.auth === 'Bearer h.e30.auth.boson.chat')).toBe(true);
  });

  it('this server\'s own things stay here: deleting "me" and the server list', async () => {
    const s = setup({ homeMe: { id: 'me-home', handle: 'alice', encrypted_user_secret: 'blob', is_discoverable: true, created_at: '' } });
    await federatedMain(s);
    s.sent.length = 0;
    await s.directory.deleteMe().catch(() => {});
    await s.directory.listServers().catch(() => {});
    expect(s.sent.map((r) => new URL(r.url).host)).toEqual(['api.boson.ircforever.org', 'api.boson.ircforever.org']);
  });

  it('home signed out: the session\'s own handle and no key; synced data is unavailable, never written here', async () => {
    const s = setup();
    await federatedMain(s);
    await s.accounts.service(BOSON_AUTH).signOut();
    s.sent.length = 0;
    const me = await s.directory.getMe();
    expect(me).toMatchObject({ handle: 'alice-bosonchat', encrypted_user_secret: '' });
    await expect(s.directory.getSavedSession()).rejects.toBeInstanceOf(HomeUnavailableError);
    await expect(s.directory.putNickservSecret('srv', 'ct')).rejects.toBeInstanceOf(HomeUnavailableError);
    expect(s.sent.filter((r) => r.url.includes('/me'))).toEqual([]);
  });

  it('home API unreachable (CORS, offline): the profile falls back, nothing breaks', async () => {
    const s = setup({ homeApi: 'down' });
    await federatedMain(s);
    expect(await s.directory.getMe()).toMatchObject({ handle: 'alice-bosonchat' });
  });

  it('a local account is untouched: everything goes to this server\'s API', async () => {
    const s = setup();
    await s.mainAuth.init();
    await s.mainAuth.signIn('bob', 'pw');
    s.sent.length = 0;
    await s.directory.getMe();
    await s.directory.getSavedSession().catch(() => {});
    expect(s.sent.map((r) => new URL(r.url).host)).toEqual(['api.boson.ircforever.org', 'api.boson.ircforever.org']);
    expect(await s.homeData.home()).toBeNull();
  });

  it('this server\'s IRC login keeps its own account: the token and the handle it gave', async () => {
    const s = setup();
    await federatedMain(s);
    const login = await resolveIrcLogin(s.accounts, 'irc.boson.ircforever.org', { interactive: false, serverName: 'IRCForever' });
    expect(login).toMatchObject({ token: 'h.e30.auth.boson.ircforever.org', nick: 'alice-bosonchat' });
  });
});

describe('IdentityKeyPrompt', () => {
  it('sets a key up at the home account when it has none, and shows its recovery code', async () => {
    const s = setup();
    await federatedMain(s);
    const identity = new IdentityService(kdf, new InMemorySecureStorage());
    render(<IdentityKeyPrompt identity={identity} homeData={s.homeData} />);
    let asked!: Promise<boolean>;
    act(() => { asked = requestIdentityKey(identity, 'nickserv'); });
    expect(await screen.findByText('Set up your identity key')).toBeTruthy();
    expect(document.querySelector('.identity-key-prompt-body')!.textContent).toMatch(/doesn't have one yet/);
    fireEvent.input(screen.getByLabelText('Passphrase'), { target: { value: 'a long passphrase' } });
    fireEvent.input(screen.getByLabelText('Confirm passphrase'), { target: { value: 'a long passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up key' }));
    expect(await screen.findByText('Save your recovery code')).toBeTruthy();
    const post = s.sent.find((r) => r.method === 'POST' && r.url === 'https://api.boson.chat/me')!;
    expect(post.body).toMatchObject({ handle: 'alice' });
    expect((post.body as { encrypted_user_secret: string }).encrypted_user_secret).toBeTruthy();
    expect(identity.isUnlocked()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /saved it/ }));
    expect(await asked).toBe(true);
  });

  it('home not signed in here: says to sign in there, sets nothing up', async () => {
    const s = setup();
    await federatedMain(s);
    await s.accounts.service(BOSON_AUTH).signOut();
    const identity = new IdentityService(kdf, new InMemorySecureStorage());
    render(<IdentityKeyPrompt identity={identity} homeData={s.homeData} />);
    let asked!: Promise<boolean>;
    act(() => { asked = requestIdentityKey(identity, 'recovery'); });
    await waitFor(() => expect(document.querySelector('.identity-key-prompt-body')?.textContent).toMatch(/sign in to boson\.chat in this browser first/));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await asked).toBe(false);
    expect(identity.isUnlocked()).toBe(false);
  });
});
