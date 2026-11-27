import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/preact';
import { AuthService } from '../../modules/auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { NetworkAccounts, sessionKeyFor } from '../../modules/netauth/network-accounts';
import { NetworkSignInHost } from './NetworkSignIn';
import { NetworkAccountBar } from './NetworkAccountBar';
import { NetworkAccountsSection } from '../UserSettings/NetworkAccountsSection';
import { setHomeNetwork } from '../../modules/netauth/home-network';

const NET = 'https://auth.net.org';

function setup(config: Record<string, unknown> = {}, onRegister?: (body: Record<string, unknown>) => ApiResponse) {
  const sent: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    const body = req.body ? JSON.parse(String(req.body)) as Record<string, unknown> : null;
    sent.push({ path: u.pathname, body });
    const ok = (v: unknown): ApiResponse => ({ status: 200, ok: true, statusText: 'OK', text: JSON.stringify(v) });
    if (u.pathname === '/v1/config') return ok({ registration: 'open', sso_providers: [], site_name: 'Net', ...config });
    if (u.pathname === '/v1/register' && onRegister) return onRegister(body!);
    if (u.pathname === '/v1/login') {
      if (body?.password !== 'right') return { status: 401, ok: false, statusText: 'Unauthorized', text: JSON.stringify({ error: 'invalid_credentials', message: 'nope' }) };
      return ok({ access_token: 'h.e30.s', expires_in: 900, refresh_token: 'rt', session_id: 's', user: { id: 'u', username: String(body.login), email: null, email_verified: true, role: 'user' } });
    }
    if (u.pathname === '/v1/password/forgot') return { status: 202, ok: true, statusText: 'Accepted', text: '' };
    return { status: 404, ok: false, statusText: 'Not Found', text: '{}' };
  });
  const storage = new InMemorySecureStorage();
  const accounts = new NetworkAccounts({
    mainAuthUrl: 'https://auth.boson.chat',
    mainAuth: new AuthService('https://auth.boson.chat', { storage, transport }),
    storage,
    transport,
    bridge: { discover: async (host: string) => ({ host, main: false, authUrl: NET }) },
    local: (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; })(),
  });
  return { accounts, sent, storage };
}

async function openPrompt(accounts: NetworkAccounts, allowGuest = true) {
  const link = (await accounts.discover('irc.net.org'))!;
  const result = accounts.promptSignIn({ link, serverName: 'Net IRC', reason: 'connect', allowGuest });
  render(<NetworkSignInHost accounts={accounts} />);
  return { result };
}

afterEach(() => cleanup());

describe('NetworkSignIn', () => {
  it("names the network and the server that sees the password, and signs in there", async () => {
    const { accounts, storage } = setup();
    const { result } = await openPrompt(accounts);
    await screen.findByRole('dialog', { name: 'Sign in to Net' });
    expect(screen.getByText('auth.net.org')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Username or email'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Wrong username/);
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await result).toBe('signed-in');
    expect(JSON.parse((await storage.get(sessionKeyFor(NET)))!).refresh_token).toBe('rt');
  });

  it('offers a guest connect when the network allows guests', async () => {
    const { accounts } = setup();
    const { result } = await openPrompt(accounts);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue as guest' }));
    expect(await result).toBe('guest');
  });

  it('says the network requires an account when it takes no guests', async () => {
    const { accounts } = setup({ guest_access: false });
    await openPrompt(accounts, true);
    await screen.findByText(/Net requires an account: guests can't connect/);
    expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull();
  });

  it('asks for an invite code on invite-only networks, and says when to check email', async () => {
    let registered: Record<string, unknown> | null = null;
    const { accounts } = setup({ registration: 'invite', require_email_verification: true }, (b) => {
      registered = b;
      return { status: 201, ok: true, statusText: 'Created', text: JSON.stringify({ email_verification_required: true }) };
    });
    await openPrompt(accounts);
    fireEvent.click(await screen.findByRole('tab', { name: 'Create account' }));
    // The code comes first, and is required.
    const first = document.querySelector('.netauth-form input') as HTMLInputElement;
    expect(first.getAttribute('aria-label')).toBe('Invite code');
    expect(first.required).toBe(true);
    fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'carol' } });
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'carol@example.org' } });
    fireEvent.input(screen.getByLabelText('Invite code'), { target: { value: 'INV-1' } });
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'a-long-password' } });
    expect(screen.getByText(/emails you a link to verify/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText('Check your email.');
    expect(registered).toMatchObject({ username: 'carol', invite_code: 'INV-1' });
  });

  it('hides sign-up when registration is closed, and sends a reset link', async () => {
    const { accounts, sent } = setup({ registration: 'closed' });
    await openPrompt(accounts);
    expect((await screen.findByText(/isn't taking new accounts/)).textContent).toMatch(/^Net isn't taking new accounts\. /);
    expect(screen.queryByRole('tab', { name: 'Create account' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.input(screen.getByLabelText('Email'), { target: { value: 'a@example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByText(/a reset link is on its way/);
    expect(sent.find((r) => r.path === '/v1/password/forgot')?.body).toEqual({ email: 'a@example.org' });
  });

  it('shows the network account in the sidebar, or a sign-in button', async () => {
    const { accounts } = setup();
    const onSignedIn = vi.fn();
    render(<NetworkAccountBar host="irc.net.org" serverName="Net IRC" accounts={accounts} onSignedIn={onSignedIn} />);
    const btn = await screen.findByRole('button', { name: 'Sign in to Net IRC' });
    fireEvent.click(btn);
    await waitFor(() => expect(accounts.getSnapshot().prompt?.reason).toBe('manage'));
    await accounts.service(NET).signIn('alice', 'right');
    accounts.resolvePrompt('signed-in');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    await screen.findByText('alice');
  });

  it('lists network accounts in Settings with sign out', async () => {
    const { accounts } = setup();
    await accounts.discover('irc.net.org');
    await accounts.service(NET).signIn('alice', 'right');
    render(<NetworkAccountsSection open accounts={accounts} />);
    await screen.findByText(/alice/);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: 'Sign in' });
  });
});

// A self-hosted network's web client in guest mode (came in through "Use
// another server" with a boson.chat account): its own network's sign-in is
// that network's form, with "Continue as alice@boson.chat".
describe('NetworkSignIn on a self-hosted web client', () => {
  afterEach(() => setHomeNetwork(null));

  it("offers the boson.chat account for the install's own network and signs in there", async () => {
    setHomeNetwork({ domain: 'boson.ircforever.org', name: 'boson.ircforever.org', selfHosted: true });
    const SELF = 'https://auth.boson.ircforever.org';
    const BOSON = 'https://auth.boson.chat';
    const fed = (domain: string) => ({
      version: 1, issuer: `https://auth.${domain}`, assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
      login_endpoint: `https://auth.${domain}/v1/federation/login`, accepts: 'directory', domain,
    });
    const seen: string[] = [];
    const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
      const u = new URL(req.url);
      seen.push(`${u.origin}${u.pathname}`);
      const ok = (v: unknown): ApiResponse => ({ status: 200, ok: true, statusText: 'OK', text: JSON.stringify(v) });
      const tokens = (extra: Record<string, unknown> = {}) => ok({ access_token: `h.e30.${u.host}`, expires_in: 900, refresh_token: 'rt', session_id: 's', user: { id: 'u', username: 'alice', email: null, email_verified: true, role: 'user' }, ...extra });
      if (u.pathname === '/v1/config') return ok({ registration: 'open', sso_providers: [], guest_access: true });
      if (u.pathname === '/v1/login') return tokens();
      if (u.pathname === '/v1/federation/assertions') return ok({ assertion: 'a', expires_in: 300 });
      if (u.pathname === '/v1/federation/login') return tokens({ federated: true, identity: 'alice@boson.chat', handle: 'alice' });
      return { status: 404, ok: false, statusText: 'Not Found', text: '{}' };
    });
    const storage = new InMemorySecureStorage();
    const mainAuth = new AuthService(SELF, { storage, transport });
    const links: Record<string, Record<string, unknown>> = {
      'irc.boson.ircforever.org': { authUrl: SELF, main: true, federation: fed('boson.ircforever.org') },
      'irc.boson.chat': { authUrl: BOSON, federation: fed('boson.chat') },
    };
    const accounts = new NetworkAccounts({
      mainAuthUrl: SELF, mainAuth, storage, transport, isGuest: () => true,
      bridge: { discover: async (host: string) => ({ host, main: false, ...(links[host] ?? {}) }) },
      local: (() => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; })(),
    });
    await accounts.discover('irc.boson.chat');
    await accounts.service(BOSON).signIn('alice', 'pw');
    const link = (await accounts.discover('irc.boson.ircforever.org'))!;
    const result = accounts.promptSignIn({ link, serverName: 'boson.ircforever.org', reason: 'connect', allowGuest: true });
    render(<NetworkSignInHost accounts={accounts} />);
    await screen.findByRole('dialog', { name: 'Sign in to boson.ircforever.org' });
    // Not the "uses your … account, leave guest mode" step.
    expect(screen.queryByText(/Signing in leaves guest mode/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue as alice@boson.chat' }));
    expect(await result).toBe('signed-in');
    expect(seen).toContain(`${SELF}/v1/federation/login`);
    expect(accounts.sessionFor(link)?.federated?.identity).toBe('alice@boson.chat');
    expect(mainAuth.getState().session).toBeNull();
  });
});
