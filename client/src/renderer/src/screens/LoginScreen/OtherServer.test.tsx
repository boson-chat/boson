import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LoginScreen } from './LoginScreen';
import { AuthProvider, type AuthService } from '../../modules/auth';
import { AuthService as RealAuthService } from '../../modules/auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { NetworkAccounts, type ResolvedNetwork } from '../../modules/netauth/network-accounts';
import { saveLastServer } from '../../modules/netauth/other-server';
import { __resetDeepLinkForTests, subscribeAddServer, subscribeDeepLink, type JoinParams } from '../../modules/deep-link/deep-link';
import { clearGuestSession, loadGuestSession } from '../../modules/guest/guest';
import { setHomeNetwork } from '../../modules/netauth/home-network';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';

const NET = 'https://auth.selfhost.org';
const IRC = { host: 'irc.selfhost.org', port: 6697, tls: true };

function setup(o: { config?: Record<string, unknown>; resolve?: (a: string) => ResolvedNetwork } = {}) {
  const registered: Array<Record<string, unknown>> = [];
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    const body = req.body ? JSON.parse(String(req.body)) as Record<string, unknown> : null;
    const ok = (v: unknown, status = 200): ApiResponse => ({ status, ok: true, statusText: 'OK', text: JSON.stringify(v) });
    const tokens = (username: string) => ok({ access_token: 'h.e30.s', expires_in: 900, refresh_token: 'rt', session_id: 's', user: { id: 'u', username, email: null, email_verified: true, role: 'user' } });
    if (u.origin !== NET) return { status: 404, ok: false, statusText: 'Not Found', text: '{}' };
    switch (u.pathname) {
      case '/v1/config': return ok({ registration: 'open', sso_providers: [{ slug: 'github', display_name: 'GitHub', start_url: 'https://auth.selfhost.org/v1/sso/github/start' }], site_name: 'Selfhost', guest_access: true, ...(o.config ?? {}) });
      case '/v1/register': registered.push(body!); return ok({ user: { id: 'u', username: body!.username } }, 201);
      case '/v1/login': return tokens(String(body!.login));
      case '/v1/token/refresh': return tokens('alice');
      default: return { status: 404, ok: false, statusText: 'Not Found', text: '{}' };
    }
  });
  const storage = new InMemorySecureStorage();
  const resolve = vi.fn(async (address: string) => (o.resolve ?? ((a: string) => ({ host: a, domain: 'selfhost.org', irc: IRC, authUrl: NET, main: false })))(address));
  const accounts = new NetworkAccounts({
    mainAuthUrl: 'https://auth.boson.chat',
    mainAuth: new RealAuthService('https://auth.boson.chat', { storage, transport }),
    storage,
    transport,
    bridge: { discover: async (host: string) => ({ host, main: false, ...(host === IRC.host ? { authUrl: NET } : {}) }), resolve },
  });
  const mainAuth = {
    getState: () => ({ session: null, loading: false, error: null }),
    subscribe: () => () => {},
    config: async () => ({ sso_providers: [] }),
  } as unknown as AuthService;
  const view = render(
    <AuthProvider service={mainAuth}>
      <LoginScreen directory={{ listServers: vi.fn(async () => []) } as unknown as DirectoryService} identity={{ isUnlocked: () => false, getState: () => ({ status: 'locked' }), subscribe: () => () => {} } as unknown as IdentityService} accounts={accounts} />
    </AuthProvider>,
  );
  return { accounts, resolve, registered, storage, view };
}

const joins: JoinParams[] = [];
beforeEach(() => {
  localStorage.clear();
  __resetDeepLinkForTests();
  joins.length = 0;
  subscribeDeepLink((p) => joins.push(p));
});
afterEach(() => { cleanup(); clearGuestSession(); __resetDeepLinkForTests(); setHomeNetwork(null); });

async function lookUp(address: string) {
  fireEvent.click(await screen.findByRole('button', { name: /use another server/i }));
  fireEvent.input(screen.getByLabelText('Server address'), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('Use another server', () => {
  it('shows boson.chat as the server and switches to another', async () => {
    setup();
    expect(document.querySelector('.login-server-host')?.textContent).toBe('boson.chat');
    fireEvent.click(screen.getByRole('button', { name: /use another server/i }));
    expect(screen.getByLabelText('Server address')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to boson.chat' }));
    expect(await screen.findByRole('tab', { name: 'Login' })).toBeTruthy();
  });

  it('signs up on the network and lands in the app with it joined', async () => {
    const { resolve, registered } = setup();
    await lookUp('https://SelfHost.org');
    // The network says who it is and what it supports.
    await screen.findByRole('heading', { name: 'Selfhost' });
    expect(resolve).toHaveBeenCalledWith('selfhost.org');
    expect(document.querySelector('.login-server-host')?.textContent).toBe('selfhost.org');
    expect(screen.getByText('Open sign-up')).toBeTruthy();
    expect(screen.getByText('Password, GitHub')).toBeTruthy();
    expect(screen.getByText('Welcome on its IRC')).toBeTruthy();
    expect(document.querySelector('.netauth-realm-host')?.textContent).toBe('auth.selfhost.org');

    fireEvent.click(screen.getByRole('tab', { name: 'Create account' }));
    fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'alice@example.org' } });
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'pw-long-enough' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(joins).toEqual([{ ...IRC, name: 'Selfhost' }]));
    expect(registered[0]).toMatchObject({ username: 'alice' });
    expect(loadGuestSession()).toEqual({ nick: 'alice' });
    expect(JSON.parse(localStorage.getItem('boson.login.lastServer')!)).toMatchObject({ address: 'selfhost.org', name: 'Selfhost', authUrl: NET });
  });

  it('offers a guest connect on the network when it allows guests', async () => {
    setup();
    await lookUp('selfhost.org');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue as guest on Selfhost' }));
    fireEvent.input(screen.getByLabelText('Pick a nick'), { target: { value: 'gus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Selfhost' }));
    expect(joins).toEqual([{ ...IRC, name: 'Selfhost' }]);
    expect(loadGuestSession()).toEqual({ nick: 'gus' });
  });

  it("doesn't offer guests when the network takes none", async () => {
    setup({ config: { guest_access: false } });
    await lookUp('selfhost.org');
    await screen.findByText('Account required');
    expect(screen.queryByRole('button', { name: /Continue as guest/ })).toBeNull();
  });

  it('a server without accounts: guest connect or plain IRC add', async () => {
    setup({ resolve: (a) => ({ host: a, domain: 'plain.org', irc: { host: 'irc.plain.org', port: 6697, tls: true }, main: false, error: 'no-accounts' }) });
    await lookUp('plain.org');
    expect((await screen.findByRole('status')).textContent).toMatch(/doesn't have accounts/);
    expect(screen.getByRole('button', { name: 'Connect as guest' })).toBeTruthy();
    const adds: string[] = [];
    subscribeAddServer((p) => adds.push(p.hostname));
    fireEvent.click(screen.getByRole('button', { name: 'Chat there as a regular IRC server' }));
    fireEvent.input(screen.getByLabelText('Pick a nick'), { target: { value: 'pat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(adds).toEqual(['plain.org']);
  });

  it('explains a server with no boson.json', async () => {
    setup({ resolve: (a) => ({ host: a, main: false, error: 'no-boson-json' }) });
    await lookUp('nothing.org');
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn't a Boson network/);
    expect(screen.getByRole('button', { name: 'Chat there as a regular IRC server' })).toBeTruthy();
  });

  it('sends boson.chat back to its own sign-in', async () => {
    setup({ resolve: (a) => ({ host: a, irc: IRC, authUrl: 'https://auth.boson.chat', main: true }) });
    await lookUp('boson.chat');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to boson.chat' }));
    expect(screen.getByRole('tab', { name: 'Login' })).toBeTruthy();
  });

  it('offers to continue to the last server while its session is valid', async () => {
    saveLastServer({ address: 'selfhost.org', name: 'Selfhost', irc: IRC, authUrl: NET });
    const { accounts } = setup();
    expect(screen.queryByRole('button', { name: /Continue to Selfhost/ })).toBeNull();
    // Signed in there (as on a past run): the shortcut appears.
    await accounts.discover(IRC.host);
    await accounts.service(NET).signIn('alice', 'pw');
    const btn = await screen.findByRole('button', { name: 'Continue to Selfhost as alice' });
    fireEvent.click(btn);
    expect(joins).toEqual([{ ...IRC, name: 'Selfhost' }]);
    expect(loadGuestSession()).toEqual({ nick: 'alice' });
  });
});

// A self-hosted network's own web client (home-network.ts): that network is
// the one the form signs in to, and boson.chat is another server.
describe('Use another server on a self-hosted web client', () => {
  beforeEach(() => setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRC Forever', selfHosted: true }));

  it('signs in to the install\'s own network, not boson.chat', async () => {
    setup();
    // A self-hosted network's sign-in waits for its settings (guest-first).
    await screen.findByRole('button', { name: /use another server/i });
    expect(document.querySelector('.login-server-host')?.textContent).toBe('boson.ircforever.org');
    expect(document.body.textContent).not.toMatch(/boson\.chat/);
    fireEvent.click(screen.getByRole('button', { name: /use another server/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to IRC Forever' }));
    expect(await screen.findByRole('tab', { name: 'Login' })).toBeTruthy();
  });

  it('reaches boson.chat as another server', async () => {
    const { resolve } = setup({
      resolve: (a) => ({ host: a, domain: 'boson.chat', irc: { host: 'irc.boson.chat', port: 6697, tls: true }, authUrl: NET, main: false }),
    });
    await lookUp('boson.chat');
    expect(resolve).toHaveBeenCalledWith('boson.chat');
    expect(await screen.findByRole('heading', { name: 'Selfhost' })).toBeTruthy();
    expect(screen.queryByText(/own network/)).toBeNull();
  });

  it('sends its own address back to its own sign-in', async () => {
    setup({ resolve: (a) => ({ host: a, irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true }, authUrl: 'https://auth.boson.ircforever.org', main: true }) });
    await lookUp('boson.ircforever.org');
    expect((await screen.findByRole('status')).textContent).toBe("boson.ircforever.org is IRC Forever's own network: it uses your IRC Forever account.");
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to IRC Forever' }));
    expect(screen.getByRole('tab', { name: 'Login' })).toBeTruthy();
  });
});
