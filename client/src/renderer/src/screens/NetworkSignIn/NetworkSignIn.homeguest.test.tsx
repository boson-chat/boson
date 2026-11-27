import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { AuthService } from '../../modules/auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { NetworkAccounts } from '../../modules/netauth/network-accounts';
import { setHomeNetwork } from '../../modules/netauth/home-network';
import { clearGuestSession, loadGuestSession, saveGuestSession } from '../../modules/guest/guest';
import { promoteHomeSession } from '../../modules/netauth/home-session';
import { NetworkSignInHost } from './NetworkSignIn';
import { NetworkAccountBar } from './NetworkAccountBar';

// A guest on a self-hosted network's own web client (chat.boson.ircforever.org)
// opens "Sign in to IRCForever" from the sidebar: an account from boson.chat
// comes first ("Continue as alice@boson.chat", or "Continue with boson.chat"
// to sign in there and come back), the network's own sign-in second.

const HOME_AUTH = 'https://auth.boson.ircforever.org';
const BOSON_AUTH = 'https://auth.boson.chat';
const HOME_IRC = { host: 'irc.boson.ircforever.org', port: 6697, tls: true };

const fed = (domain: string, accepts = 'directory') => ({
  version: 1, issuer: `https://auth.${domain}`, accepts, domain,
  assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
  login_endpoint: `https://auth.${domain}/v1/federation/login`,
});
const json = (status: number, v: unknown): ApiResponse => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });

function selfHosted(o: { accepts?: string; registration?: string; resolve?: boolean } = {}) {
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    const tokens = (username: string, extra = {}) => json(200, {
      access_token: `h.e30.${u.host}`, expires_in: 900, refresh_token: `rt-${u.host}`, session_id: 's',
      user: { id: `u-${u.host}`, username, email: null, email_verified: true, role: 'user' }, ...extra,
    });
    if (u.pathname === '/v1/config') {
      return json(200, u.host === 'auth.boson.chat'
        ? { registration: 'open', sso_providers: [], site_name: 'boson.chat', guest_access: true }
        : { registration: o.registration ?? 'closed', sso_providers: [], network_name: 'IRCForever', guest_access: true, guest_first: true });
    }
    if (u.pathname === '/v1/login') return tokens('alice');
    if (u.pathname === '/v1/federation/assertions') return json(200, { assertion: 'jwt', expires_in: 300 });
    if (u.pathname === '/v1/federation/login') return tokens('alice-bosonchat', { federated: true, identity: 'alice@boson.chat', handle: 'alice-bosonchat' });
    return json(404, {});
  });
  const storage = new InMemorySecureStorage();
  const resolve = vi.fn(async (address: string) => ({
    host: address, domain: 'boson.chat', irc: { host: 'irc.boson.chat', port: 6697, tls: true }, authUrl: BOSON_AUTH, main: false,
    federation: fed('boson.chat'),
  }));
  const mainAuth = new AuthService(HOME_AUTH, { storage, transport });
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
      ...(o.resolve === false ? {} : { resolve }),
    },
  });
  return { accounts, mainAuth, resolve };
}

// The sidebar's "Sign in to IRCForever" (NetworkAccountBar).
async function openFromSidebar(accounts: NetworkAccounts) {
  render(<><NetworkAccountBar host={HOME_IRC.host} serverName="IRCForever" accounts={accounts} /><NetworkSignInHost accounts={accounts} /></>);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in to IRCForever' }));
  return screen.findByRole('dialog', { name: 'Sign in to IRCForever' });
}

beforeEach(() => {
  localStorage.clear();
  setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRCForever', selfHosted: true, irc: HOME_IRC });
  saveGuestSession({ nick: 'ZestyKiwi' });
});
afterEach(() => { cleanup(); clearGuestSession(); setHomeNetwork(null); });

describe('Sign in to the home network as a guest', () => {
  it('tells the guest what an account keeps', async () => {
    const { accounts } = selfHosted();
    render(<NetworkAccountBar host={HOME_IRC.host} serverName="IRCForever" accounts={accounts} />);
    expect((await screen.findByTestId('guest-keep-hint')).textContent).toBe('Sign in to keep your nick and history.');
    cleanup();
    const open = selfHosted({ registration: 'open' });
    render(<NetworkAccountBar host={HOME_IRC.host} serverName="IRCForever" accounts={open.accounts} />);
    await waitFor(() => expect(screen.getByTestId('guest-keep-hint').textContent).toBe('Create an account or sign in to keep your nick and history.'));
  });

  it('leads with "Continue with boson.chat", round trip included, and upgrades the guest in place', async () => {
    const { accounts, mainAuth, resolve } = selfHosted();
    const dialog = await openFromSidebar(accounts);
    const cta = await screen.findByRole('button', { name: /Continue with boson\.chat/ });
    // Local sign-in second; closed registration: no sign-up form.
    expect(screen.getByLabelText('Username or email')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Create account' })).toBeNull();
    expect(dialog.textContent).toContain("IRCForever isn't taking new accounts. Use your boson.chat account, or sign in if you have an account here.");
    // Nothing about IRCForever being separate from itself.
    expect(dialog.textContent).not.toMatch(/separate from/);
    const order = [...document.querySelectorAll('button, input')];
    expect(order.indexOf(cta)).toBeLessThan(order.indexOf(screen.getByLabelText('Username or email')));

    fireEvent.click(cta);
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('boson.chat'));
    expect(await screen.findByText(/Then you'll come back to IRCForever/)).toBeTruthy();
    fireEvent.input(await screen.findByLabelText('Username or email'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // Back on IRCForever's sign-in, continuing as alice@boson.chat by itself.
    await waitFor(() => expect(accounts.sessionFor({ host: HOME_IRC.host, authUrl: HOME_AUTH, main: true })?.federated?.identity).toBe('alice@boson.chat'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The guest's session becomes the app's own (home-session.ts): guest mode ends in place.
    expect(await promoteHomeSession(accounts)).toBe(true);
    expect(mainAuth.getState().session?.federated?.identity).toBe('alice@boson.chat');
    expect(loadGuestSession()).toBeNull();
  });

  it('with a boson.chat account signed in here: "Continue as alice@boson.chat" first', async () => {
    const { accounts } = selfHosted();
    await accounts.discover('irc.boson.chat');
    await accounts.service(BOSON_AUTH).signIn('alice', 'pw');
    await openFromSidebar(accounts);
    const choice = await screen.findByRole('button', { name: 'Continue as alice@boson.chat' });
    expect(screen.queryByRole('button', { name: /Continue with boson\.chat/ })).toBeNull();
    fireEvent.click(choice);
    await waitFor(() => expect(accounts.sessionFor({ host: HOME_IRC.host, authUrl: HOME_AUTH, main: true })?.federated?.identity).toBe('alice@boson.chat'));
  });

  it('federation off: the local sign-in only, no footer about other accounts', async () => {
    const { accounts } = selfHosted({ accepts: 'off' });
    const dialog = await openFromSidebar(accounts);
    expect(await screen.findByLabelText('Username or email')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Continue with boson\.chat/ })).toBeNull();
    expect(dialog.textContent).toContain("IRCForever isn't taking new accounts. Sign in if you have an account.");
    expect(dialog.textContent).not.toMatch(/separate from/);
  });
});
