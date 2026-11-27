import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LoginScreen } from './LoginScreen';
import { AuthProvider, type AuthConfig, type AuthService } from '../../modules/auth';
import { AuthService as RealAuthService } from '../../modules/auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { NetworkAccounts } from '../../modules/netauth/network-accounts';
import { __resetDeepLinkForTests, subscribeDeepLink, type JoinParams } from '../../modules/deep-link/deep-link';
import { clearGuestSession, loadGuestSession } from '../../modules/guest/guest';
import { setHomeNetwork } from '../../modules/netauth/home-network';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';

// The sign-in screen follows the home network's registration: open
// (Login / Signup), invite-only (the code first, required) or closed (no
// Signup; an account from another Boson server, or a guest, instead).

const HOME_AUTH = 'https://auth.boson.ircforever.org';
const BOSON_AUTH = 'https://auth.boson.chat';
const HOME_IRC = { host: 'irc.boson.ircforever.org', port: 6697, tls: true };

const fed = (domain: string, accepts = 'directory') => ({
  version: 1, issuer: `https://auth.${domain}`, accepts, domain,
  assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
  login_endpoint: `https://auth.${domain}/v1/federation/login`,
});
const json = (status: number, v: unknown): ApiResponse => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });

function fakeMainAuth(cfg: Partial<AuthConfig>, extra: Partial<Record<keyof AuthService, unknown>> = {}): AuthService {
  return {
    getState: () => ({ session: null, loading: false, error: null }),
    subscribe: () => () => {},
    config: async () => ({ sso_providers: [], ...cfg }),
    signUp: vi.fn(async () => ({ verificationRequired: true })),
    ...extra,
  } as unknown as AuthService;
}

const directory = { listServers: vi.fn(async () => []) } as unknown as DirectoryService;
const identity = { isUnlocked: () => false, getState: () => ({ status: 'locked' }), subscribe: () => () => {} } as unknown as IdentityService;

// After a passwordless sign-in: no key in the keychain, no profile yet.
const newUserDirectory = { listServers: vi.fn(async () => []), getMe: vi.fn(async () => null) } as unknown as DirectoryService;
const newUserIdentity = {
  isUnlocked: () => false, getState: () => ({ status: 'locked' }), subscribe: () => () => {}, restoreFromStorage: vi.fn(async () => false),
} as unknown as IdentityService;

function renderLogin(auth: AuthService, accounts: NetworkAccounts | null = null, deps: { directory?: DirectoryService; identity?: IdentityService } = {}) {
  return render(
    <AuthProvider service={auth}>
      <LoginScreen directory={deps.directory ?? directory} identity={deps.identity ?? identity} accounts={accounts} />
    </AuthProvider>,
  );
}

// A self-hosted web client's NetworkAccounts: its own network (federation
// accepts `accepts`), boson.chat as a home server that vouches.
function selfHosted(o: { accepts?: string; fedLoginError?: string; home?: Record<string, unknown> } = {}) {
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    const tokens = (username: string, extra = {}) => json(200, {
      access_token: `h.e30.${u.host}`, expires_in: 900, refresh_token: `rt-${u.host}`, session_id: 's',
      user: { id: `u-${u.host}`, username, email: null, email_verified: true, role: 'user' }, ...extra,
    });
    if (u.pathname === '/v1/config') {
      return json(200, u.host === 'auth.boson.chat'
        ? { registration: 'open', sso_providers: [], site_name: 'boson.chat', guest_access: true }
        : { registration: 'open', sso_providers: [], network_name: 'IRCForever', guest_access: true, ...(o.home ?? {}) });
    }
    if (u.pathname === '/v1/logout') return json(204, {});
    if (u.pathname === '/v1/login') return tokens('alice');
    if (u.pathname === '/v1/federation/assertions') return json(200, { assertion: 'jwt', expires_in: 300 });
    if (u.pathname === '/v1/federation/login') {
      if (o.fedLoginError) return json(403, { error: o.fedLoginError, message: 'no' });
      return tokens('alice-bosonchat', { federated: true, identity: 'alice@boson.chat', handle: 'alice-bosonchat' });
    }
    return json(404, {});
  });
  const storage = new InMemorySecureStorage();
  const resolve = vi.fn(async (address: string) => ({
    host: address, domain: 'boson.chat', irc: { host: 'irc.boson.chat', port: 6697, tls: true }, authUrl: BOSON_AUTH, main: false,
    federation: fed('boson.chat'),
  }));
  const mainAuth = new RealAuthService(HOME_AUTH, { storage, transport });
  const accounts = new NetworkAccounts({
    mainAuthUrl: HOME_AUTH,
    mainAuth,
    storage,
    transport,
    isGuest: () => loadGuestSession() !== null,
    bridge: {
      discover: async (host: string) => (host === 'auth.boson.ircforever.org' || host === HOME_IRC.host
        ? { host, main: true, authUrl: HOME_AUTH, federation: { ...fed('boson.ircforever.org', o.accepts ?? 'directory'), domain: undefined } }
        : { host, main: false, authUrl: BOSON_AUTH, federation: fed('boson.chat') }),
      resolve,
    },
  });
  return { accounts, mainAuth, transport, resolve };
}

const joins: JoinParams[] = [];
beforeEach(() => {
  localStorage.clear();
  __resetDeepLinkForTests();
  joins.length = 0;
  subscribeDeepLink((p) => joins.push(p));
});
afterEach(() => { cleanup(); clearGuestSession(); __resetDeepLinkForTests(); setHomeNetwork(null); });

describe('LoginScreen registration', () => {
  it('open: Login and Signup tabs', async () => {
    renderLogin(fakeMainAuth({ registration: 'open' }));
    expect(await screen.findByRole('tab', { name: 'Signup' })).toBeTruthy();
    expect(screen.queryByText(/isn't taking new accounts/)).toBeNull();
  });

  it('closed: no Signup tab, sign-in for existing accounts, and a line saying what is left', async () => {
    renderLogin(fakeMainAuth({ registration: 'closed', guest_access: true }));
    expect((await screen.findByRole('status')).textContent).toBe(
      "boson.chat isn't taking new accounts. Sign in if you have an account, or continue as a guest.",
    );
    expect(screen.queryByRole('tab', { name: 'Signup' })).toBeNull();
    expect(screen.getByPlaceholderText('username or email')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue without an account' })).toBeTruthy();
  });

  it('closed (accounts.signup false): no Signup, no guest mention when guests are off', async () => {
    renderLogin(fakeMainAuth({ registration: 'open', accounts: { signup: false }, guest_access: false }));
    expect((await screen.findByRole('status')).textContent).toBe("boson.chat isn't taking new accounts. Sign in if you have an account.");
    expect(screen.queryByRole('tab', { name: 'Signup' })).toBeNull();
  });

  it('invite: the invite code comes first, is required, and is sent', async () => {
    const auth = fakeMainAuth({ registration: 'invite' });
    renderLogin(auth);
    fireEvent.click(await screen.findByRole('tab', { name: 'Signup' }));
    const inputs = [...document.querySelectorAll('form input')] as HTMLInputElement[];
    expect(inputs[0]!.placeholder).toBe('invite code');
    expect(inputs[0]!.required).toBe(true);
    expect(screen.getByText(/takes new accounts by invite/)).toBeTruthy();

    fireEvent.input(screen.getByPlaceholderText('username'), { target: { value: 'carol' } });
    fireEvent.input(screen.getByPlaceholderText('email'), { target: { value: 'carol@example.com' } });
    fireEvent.input(screen.getByPlaceholderText('password'), { target: { value: 'correct horse battery' } });
    fireEvent.input(screen.getByPlaceholderText('confirm password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('Enter the invite code you were given.')).toBeTruthy();
    expect(auth.signUp).not.toHaveBeenCalled();

    fireEvent.input(screen.getByPlaceholderText('invite code'), { target: { value: ' inv-1 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    await waitFor(() => expect(auth.signUp).toHaveBeenCalledWith({
      username: 'carol', email: 'carol@example.com', password: 'correct horse battery', invite_code: 'inv-1',
    }));
  });

  it('open: no invite code field', async () => {
    renderLogin(fakeMainAuth({ registration: 'open' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Signup' }));
    expect(screen.queryByPlaceholderText('invite code')).toBeNull();
  });
});

describe('LoginScreen registration on a self-hosted web client', () => {
  beforeEach(() => setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRCForever', selfHosted: true, irc: HOME_IRC }));

  it('closed + federation: "Continue with boson.chat" signs in there, then comes back as that account', async () => {
    const { accounts, mainAuth, resolve } = selfHosted({ home: { registration: 'closed' } });
    renderLogin(mainAuth, accounts, { directory: newUserDirectory, identity: newUserIdentity });
    const cta = await screen.findByRole('button', { name: /Continue with boson\.chat/ });
    expect(screen.getByText(/isn't taking new accounts/).textContent).toBe(
      "IRCForever isn't taking new accounts. Use your boson.chat account, or continue as a guest.",
    );
    expect(screen.queryByRole('tab', { name: 'Signup' })).toBeNull();
    fireEvent.click(cta);

    // boson.chat is looked up at once, with a line saying why.
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('boson.chat'));
    expect(await screen.findByText(/Then you'll come back to IRCForever/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Continue as guest/ })).toBeNull();
    fireEvent.input(await screen.findByLabelText('Username or email'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Back on IRCForever: the app's own account is signed in as
    // alice@boson.chat (not guest mode beside a network session), and the
    // identity key comes next, as after any passwordless sign-in.
    expect(await screen.findByText('Set an identity passphrase.')).toBeTruthy();
    expect(mainAuth.getState().session?.federated).toMatchObject({ identity: 'alice@boson.chat', homeDomain: 'boson.chat', handle: 'alice-bosonchat' });
    expect(loadGuestSession()).toBeNull();
    expect(accounts.sessionFor({ host: HOME_IRC.host, authUrl: HOME_AUTH, main: true })).toBe(mainAuth.getState().session);
  });

  it('an account already signed in here: "Continue as alice@boson.chat"', async () => {
    const { accounts, mainAuth } = selfHosted({ home: { registration: 'closed', guest_access: false } });
    await accounts.discover('irc.boson.chat');
    await accounts.service(BOSON_AUTH).signIn('alice', 'pw');
    renderLogin(mainAuth, accounts, { directory: newUserDirectory, identity: newUserIdentity });
    const choice = await screen.findByRole('button', { name: 'Continue as alice@boson.chat' });
    expect(screen.queryByRole('button', { name: /Continue with boson\.chat/ })).toBeNull();
    expect(screen.getByText(/isn't taking new accounts/).textContent).toBe(
      "IRCForever isn't taking new accounts. Use your boson.chat account, or sign in if you have an account here.",
    );
    fireEvent.click(choice);
    expect(await screen.findByText('Set an identity passphrase.')).toBeTruthy();
    expect(mainAuth.getState().session?.federated?.identity).toBe('alice@boson.chat');
    expect(loadGuestSession()).toBeNull();
  });

  it('a refused federated sign-in says why and leaves guest mode off', async () => {
    const { accounts, mainAuth } = selfHosted({ fedLoginError: 'domain_not_trusted', home: { registration: 'closed' } });
    await accounts.discover('irc.boson.chat');
    await accounts.service(BOSON_AUTH).signIn('alice', 'pw');
    renderLogin(mainAuth, accounts);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue as alice@boson.chat' }));
    expect((await screen.findByText(/isn't verified in the directory/)).textContent).toMatch(/boson\.chat/);
    expect(loadGuestSession()).toBeNull();
    expect(mainAuth.getState().session).toBeNull();
  });

  it('federation off: no boson.chat option', async () => {
    const { accounts } = selfHosted({ accepts: 'off' });
    renderLogin(fakeMainAuth({ registration: 'closed', guest_access: true }), accounts);
    expect((await screen.findByText(/isn't taking new accounts/)).textContent).toBe(
      "IRCForever isn't taking new accounts. Sign in if you have an account, or continue as a guest.",
    );
    // Let the federation lookup settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Continue with boson\.chat/ })).toBeNull();
  });

  it('open registration: Signup stays, no boson.chat option', async () => {
    const { accounts } = selfHosted();
    renderLogin(fakeMainAuth({ registration: 'open' }), accounts);
    expect(await screen.findByRole('tab', { name: 'Signup' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Continue with boson\.chat/ })).toBeNull();
  });
});
