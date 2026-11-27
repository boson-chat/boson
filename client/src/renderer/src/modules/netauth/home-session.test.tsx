import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { AuthService } from '../auth/auth.service';
import { AuthProvider } from '../auth';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { NetworkAccounts } from './network-accounts';
import { keepHomeSessionSignedIn, promoteHomeSession } from './home-session';
import { clearGuestSession, loadGuestSession, onGuestChange, saveGuestSession } from '../guest/guest';
import { setHomeNetwork } from './home-network';
import { takeResumeIdentity } from '../auth/resume-identity';
import { signOut, __resetSignOut } from '../signout/sign-out';
import { LoginScreen } from '../../screens/LoginScreen/LoginScreen';
import { TitleBar } from '../../screens/TitleBar/TitleBar';
import { AccountSection } from '../../screens/UserSettings/AccountSection';
import type { DirectoryService } from '../directory';
import type { IdentityService } from '../identity';

// Signed in to a self-hosted web client's own network is signed in, not a
// guest: a home network session made beside guest mode (the network
// sign-in dialog, or an earlier version's sign-in screen) becomes the app's
// own account, and everything follows the main session from there.

const HOME_AUTH = 'https://auth.boson.ircforever.org';
const BOSON_AUTH = 'https://auth.boson.chat';
const fed = (domain: string) => ({
  version: 1, issuer: `https://auth.${domain}`, accepts: 'directory', domain,
  assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
  login_endpoint: `https://auth.${domain}/v1/federation/login`,
});
const json = (status: number, v: unknown): ApiResponse => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });

function setup() {
  const sent: Array<{ url: string; body: unknown }> = [];
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    sent.push({ url: req.url, body: req.body ? JSON.parse(String(req.body)) : null });
    const tokens = (username: string, extra = {}) => json(200, {
      access_token: `h.e30.${u.host}`, expires_in: 900, refresh_token: `rt-${u.host}`, session_id: 's',
      user: { id: `u-${u.host}`, username, email: null, email_verified: true, role: 'user' }, ...extra,
    });
    if (u.pathname === '/v1/config') return json(200, { registration: 'closed', sso_providers: [] });
    if (u.pathname === '/v1/login') return tokens('alice');
    if (u.pathname === '/v1/token/refresh') return tokens('alice-bosonchat');
    if (u.pathname === '/v1/federation/assertions') return json(200, { assertion: 'jwt', expires_in: 300 });
    if (u.pathname === '/v1/federation/login') return tokens('alice-bosonchat', { federated: true, identity: 'alice@boson.chat', handle: 'alice-bosonchat' });
    if (u.pathname === '/v1/logout') return json(204, {});
    return json(404, {});
  });
  const storage = new InMemorySecureStorage();
  const mainAuth = new AuthService(HOME_AUTH, { storage, transport });
  const accounts = new NetworkAccounts({
    mainAuthUrl: HOME_AUTH, mainAuth, storage, transport,
    isGuest: () => loadGuestSession() !== null,
    bridge: {
      discover: async (host: string) => (host.endsWith('ircforever.org')
        ? { host, main: true, authUrl: HOME_AUTH, federation: fed('boson.ircforever.org') }
        : { host, main: false, authUrl: BOSON_AUTH, federation: fed('boson.chat') }),
    },
  });
  return { accounts, mainAuth, storage, sent };
}

// The state the bug report saw: guest mode, the home network signed in
// beside it as alice@boson.chat.
async function guestWithFederatedHome(s: ReturnType<typeof setup>) {
  await s.mainAuth.init();
  await s.accounts.discover('irc.boson.chat');
  await s.accounts.service(BOSON_AUTH).signIn('alice', 'pw');
  saveGuestSession({ nick: 'alice-bosonchat' });
  const home = (await s.accounts.discover('irc.boson.ircforever.org'))!;
  const [h] = await s.accounts.homeAccounts(home);
  await s.accounts.signInFederated(home, h!);
  return home;
}

beforeEach(() => {
  localStorage.clear();
  setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRCForever', selfHosted: true, irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true } });
  takeResumeIdentity();
});
afterEach(() => { cleanup(); clearGuestSession(); setHomeNetwork(null); __resetSignOut(); });

describe('home network session → the app account', () => {
  it('moves a federated home session made beside guest mode to the main account and ends guest mode', async () => {
    const s = setup();
    await guestWithFederatedHome(s);
    expect(s.mainAuth.getState().session).toBeNull();
    const changed = vi.fn();
    const off = onGuestChange(changed);

    expect(await promoteHomeSession(s.accounts)).toBe(true);
    off();
    expect(loadGuestSession()).toBeNull();
    expect(changed).toHaveBeenCalled();
    expect(s.mainAuth.getState().session?.federated).toMatchObject({ identity: 'alice@boson.chat', homeDomain: 'boson.chat' });
    // The login screen goes straight to the identity key.
    expect(takeResumeIdentity()).toBe(true);
    // One keeper: the network-side copy is gone (no double refresh), and the
    // home network now reads the main session.
    const home = s.accounts.linkFor('irc.boson.ircforever.org')!;
    expect(s.accounts.sessionFor(home)).toBe(s.mainAuth.getState().session);
    // It survives a reload, as the main session.
    const again = new AuthService(HOME_AUTH, { storage: s.storage, transport: vi.fn(async () => json(200, {
      access_token: 'h.e30.x', expires_in: 900, refresh_token: 'rt2', session_id: 's', user: { id: 'u', username: 'alice-bosonchat', email: null, email_verified: true, role: 'user' },
    })) });
    await again.init();
    expect(again.getState().session?.federated?.identity).toBe('alice@boson.chat');
  });

  it('does nothing outside guest mode, without a home session, or on boson.chat itself', async () => {
    const s = setup();
    await s.mainAuth.init();
    expect(await promoteHomeSession(s.accounts)).toBe(false);
    saveGuestSession({ nick: 'g' });
    expect(await promoteHomeSession(s.accounts)).toBe(false);
    expect(loadGuestSession()).toEqual({ nick: 'g' });
    setHomeNetwork(null);
    const t = setup();
    await guestWithFederatedHome(t).catch(() => {});
    expect(await promoteHomeSession(t.accounts)).toBe(false);
  });

  it('promotes when the home network is signed in to later (the network sign-in dialog)', async () => {
    const s = setup();
    await s.mainAuth.init();
    await s.accounts.discover('irc.boson.chat');
    await s.accounts.service(BOSON_AUTH).signIn('alice', 'pw');
    saveGuestSession({ nick: 'alice' });
    const stop = keepHomeSessionSignedIn(s.accounts, Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));
    expect(loadGuestSession()).toEqual({ nick: 'alice' });
    const home = (await s.accounts.discover('irc.boson.ircforever.org'))!;
    const [h] = await s.accounts.homeAccounts(home);
    await s.accounts.signInFederated(home, h!);
    await vi.waitFor(() => expect(loadGuestSession()).toBeNull());
    expect(s.mainAuth.getState().session?.federated?.identity).toBe('alice@boson.chat');
    stop();
  });

  it('the login screen goes straight to the identity key for a federated session', async () => {
    const s = setup();
    await guestWithFederatedHome(s);
    await promoteHomeSession(s.accounts);
    const getMe = vi.fn(async () => ({ handle: 'alice', encrypted_user_secret: 'blob' }));
    render(
      <AuthProvider service={s.mainAuth}>
        <LoginScreen
          directory={{ listServers: async () => [], getMe } as unknown as DirectoryService}
          identity={{ isUnlocked: () => false, getState: () => ({ status: 'locked' }), subscribe: () => () => {}, restoreFromStorage: async () => false } as unknown as IdentityService}
          accounts={s.accounts}
        />
      </AuthProvider>,
    );
    expect(await screen.findByText('Unlock your identity key.')).toBeTruthy();
    expect(screen.getByText(/Signed in as/).textContent).toMatch(/alice-bosonchat/);
  });

  it('signing out ends the federated session at the home network', async () => {
    const s = setup();
    await guestWithFederatedHome(s);
    await promoteHomeSession(s.accounts);
    await signOut({ auth: s.mainAuth, identity: { lock: () => {} } });
    expect(s.mainAuth.getState().session).toBeNull();
    expect(s.sent.some((r) => r.url === `${HOME_AUTH}/v1/logout`)).toBe(true);
    // The boson.chat account it came from stays signed in.
    expect(s.accounts.service(BOSON_AUTH).getState().session).not.toBeNull();
  });
});

describe('a federated account in the title bar and Settings', () => {
  it('shows the name with the @home hint and no guest tag', () => {
    render(<TitleBar userLabel="alice-bosonchat" userMode="account" userHomeDomain="boson.chat" onOpenSettings={() => {}} />);
    const chip = screen.getByRole('button', { name: 'User settings' });
    expect(chip.textContent).toContain('alice-bosonchat');
    expect(chip.textContent).toContain('@boson.chat');
    expect(chip.textContent).not.toMatch(/guest/i);
  });

  it('a guest keeps the guest tag and no home hint', () => {
    render(<TitleBar userLabel="pat" userMode="guest" userHomeDomain="boson.chat" onOpenSettings={() => {}} />);
    const chip = screen.getByRole('button', { name: 'User settings' });
    expect(chip.textContent).toMatch(/guest/);
    expect(chip.textContent).not.toContain('@boson.chat');
  });

  it('Account & security says who signs you in', async () => {
    const s = setup();
    await guestWithFederatedHome(s);
    await promoteHomeSession(s.accounts);
    render(
      <AccountSection
        mode="account" authedEmail={null} onSignOut={() => {}} onClose={() => {}} open={false}
        directory={{} as DirectoryService} identity={{} as IdentityService} auth={s.mainAuth}
      />,
    );
    const row = document.querySelector('.user-settings-federated')!;
    expect(row.textContent).toContain('alice@boson.chat');
    expect(row.textContent).toContain('boson.chat vouches for you');
    expect(document.querySelector('.user-settings-email')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
