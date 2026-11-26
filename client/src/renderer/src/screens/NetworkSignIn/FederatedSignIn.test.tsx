import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { AuthService } from '../../modules/auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { NetworkAccounts } from '../../modules/netauth/network-accounts';
import { NetworkSignInHost } from './NetworkSignIn';
import { NetworkAccountBar } from './NetworkAccountBar';
import { NetworkAccountsSection } from '../UserSettings/NetworkAccountsSection';

const MAIN = 'https://auth.boson.chat';
const REMOTE = 'https://auth.remote.org';

const fed = (domain: string, accepts = 'directory') => ({
  version: 1, issuer: `https://auth.${domain}`, accepts, domain,
  assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
  login_endpoint: `https://auth.${domain}/v1/federation/login`,
});

const json = (status: number, v: unknown): ApiResponse => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });

function setup(o: { loginError?: string; registration?: string } = {}) {
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    const tokens = (username: string, extra = {}) => json(200, {
      access_token: `at-${u.host}`, expires_in: 900, refresh_token: `rt-${u.host}`, session_id: 's',
      user: { id: `u-${u.host}`, username, email: null, email_verified: true, role: 'user' }, ...extra,
    });
    if (u.pathname === '/v1/config') return json(200, { registration: o.registration ?? 'open', sso_providers: [], site_name: 'Remote Net' });
    if (u.pathname === '/v1/login') return tokens('alice');
    if (u.pathname === '/v1/federation/assertions') return json(200, { assertion: 'jwt', expires_in: 300 });
    if (u.pathname === '/v1/federation/login') {
      if (o.loginError) return json(403, { error: o.loginError, message: 'no' });
      return tokens('alice-bosonchat', { federated: true, identity: 'alice@boson.chat', handle: 'alice-bosonchat' });
    }
    return json(404, {});
  });
  const storage = new InMemorySecureStorage();
  const mainAuth = new AuthService(MAIN, { storage, transport });
  const accounts = new NetworkAccounts({
    mainAuthUrl: MAIN, mainAuth, storage, transport,
    bridge: {
      discover: async (host: string) => (host === 'boson.chat'
        ? { host, main: true, authUrl: MAIN, federation: fed('boson.chat') }
        : { host, main: false, authUrl: REMOTE, federation: fed('remote.org') }),
    },
    local: (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; })(),
  });
  return { accounts, mainAuth, transport };
}

async function open(accounts: NetworkAccounts) {
  const link = (await accounts.discover('irc.remote.org'))!;

  const result = accounts.promptSignIn({ link, serverName: 'Remote', reason: 'connect', allowGuest: true });
  render(<NetworkSignInHost accounts={accounts} />);
  return { link, result };
}

afterEach(() => cleanup());

describe('Continue as … (federated sign-in)', () => {
  it('offers the home account above the sign-in form and signs in with it', async () => {
    const { accounts, mainAuth } = setup();
    await mainAuth.signIn('alice', 'pw');
    const { link, result } = await open(accounts);
    const choice = await screen.findByRole('button', { name: /Continue as alice@boson\.chat/ });
    // Above the usual sign in / create account options.
    const tabs = screen.getByRole('tab', { name: 'Sign in' });
    expect(choice.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(choice);
    expect(await result).toBe('signed-in');
    expect(accounts.sessionFor(link)?.federated?.handle).toBe('alice-bosonchat');
  });

  it("shows nothing extra when you're signed in nowhere that can vouch", async () => {
    const { accounts } = setup();
    await open(accounts);
    await screen.findByRole('tab', { name: 'Sign in' });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Continue as alice/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Continue as alice/ })).toBeNull();
  });

  it('explains a refusal and offers to create an account here instead', async () => {
    const { accounts, mainAuth } = setup({ loginError: 'domain_not_trusted' });
    await mainAuth.signIn('alice', 'pw');
    await open(accounts);
    fireEvent.click(await screen.findByRole('button', { name: /Continue as alice@boson\.chat/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/This server only accepts accounts from verified Boson servers/);
    // A trust refusal won't change on a retry.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account here instead' }));
    await waitFor(() => expect(screen.getByLabelText('Username')).toBeTruthy());
    expect(screen.getByRole('tab', { name: 'Create account' }).getAttribute('aria-selected')).toBe('true');
  });

  it('offers a retry for a passing failure, and no sign-up where there is none', async () => {
    const { accounts, mainAuth } = setup({ loginError: 'replayed', registration: 'closed' });
    await mainAuth.signIn('alice', 'pw');
    await open(accounts);
    fireEvent.click(await screen.findByRole('button', { name: /Continue as alice@boson\.chat/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already used/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create an account here instead' })).toBeNull();
  });

  it('shows the home domain in the account bar and settings, linked', async () => {
    const { accounts, mainAuth } = setup();
    await mainAuth.signIn('alice', 'pw');
    const link = (await accounts.discover('irc.remote.org'))!;
    await accounts.signInFederated(link, (await accounts.homeAccounts(link))[0]!);
    render(<NetworkAccountBar host="irc.remote.org" serverName="Remote" accounts={accounts} />);
    await screen.findByText('alice-bosonchat');
    expect(screen.getByText('@boson.chat')).toBeTruthy();
    cleanup();

    render(<NetworkAccountsSection open accounts={accounts} />);
    expect(await screen.findByText('Linked')).toBeTruthy();
    expect(screen.getByText(/alice-bosonchat · with alice@boson\.chat/)).toBeTruthy();
    expect(screen.getByTestId('federated-note').textContent).toMatch(/Signing out of boson\.chat doesn't sign you out/);
  });
});
