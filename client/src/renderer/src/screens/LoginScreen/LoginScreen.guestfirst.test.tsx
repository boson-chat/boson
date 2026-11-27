import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LoginScreen } from './LoginScreen';
import { AuthProvider, type AuthConfig, type AuthService } from '../../modules/auth';
import { clearGuestSession, loadGuestSession } from '../../modules/guest/guest';
import {
  __setGuestFirstLinkForTests, lastGuestNick, rememberGuestNick, setGuestLanding, takeGuestLanding,
} from '../../modules/guest/guest-first';
import { setHomeNetwork } from '../../modules/netauth/home-network';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';

// Guest-first entry (the home network's guest_first): a ready nick and
// "Join chat" in place of the sign-in form; sign-in a click away.

const CHANNELS = [
  { name: '#staff', autojoin: true, restricted: true },
  { name: '#IRCForever', autojoin: true },
  { name: '#help', autojoin: false },
];

function auth(cfg: Partial<AuthConfig>): AuthService {
  return {
    getState: () => ({ session: null, loading: false, error: null }),
    subscribe: () => () => {},
    config: async () => ({ sso_providers: [], registration: 'closed', guest_access: true, guest_first: true, channels: CHANNELS, ...cfg }),
  } as unknown as AuthService;
}

const directory = { listServers: async () => [] } as unknown as DirectoryService;
const identity = { isUnlocked: () => false, getState: () => ({ status: 'locked' }), subscribe: () => () => {} } as unknown as IdentityService;

function renderLogin(cfg: Partial<AuthConfig> = {}) {
  return render(
    <AuthProvider service={auth(cfg)}>
      <LoginScreen directory={directory} identity={identity} accounts={null} />
    </AuthProvider>,
  );
}

const nickBox = () => screen.getByRole('textbox', { name: 'Nickname' }) as HTMLInputElement;
const joinButton = () => screen.getByRole('button', { name: 'Join chat' });

beforeEach(() => {
  setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRCForever', selfHosted: true, irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true } });
  __setGuestFirstLinkForTests({});
});
afterEach(() => {
  cleanup();
  clearGuestSession();
  localStorage.clear();
  setHomeNetwork(null);
  setGuestLanding(null);
  __setGuestFirstLinkForTests(null);
});

describe('guest-first entry', () => {
  it('opens on a ready nick and joins the landing channel after the auto-join ones', async () => {
    renderLogin();
    expect(await screen.findByRole('heading', { name: 'IRCForever', level: 1 })).toBeTruthy();
    expect(screen.getByText('#IRCForever')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Username or email' })).toBeNull();
    const nick = nickBox().value;
    expect(nick).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
    // Registration is closed: sign in only.
    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull();

    fireEvent.click(joinButton());
    expect(loadGuestSession()).toEqual({ nick });
    expect(lastGuestNick()).toEqual({ nick, auto: true });
    expect(takeGuestLanding()).toEqual({ focus: '#IRCForever', channels: ['#IRCForever'] });
  });

  it('lands on guest_first_channel and offers sign-up when registration is open', async () => {
    renderLogin({ guest_first_channel: '#help', registration: 'open' });
    expect(await screen.findByText('#help')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create an account' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(await screen.findByRole('tab', { name: 'Signup', selected: true })).toBeTruthy();
  });

  it('keeps a typed nick (not renamed on a collision) and another roll is made for them', async () => {
    renderLogin();
    await screen.findByRole('button', { name: 'Join chat' });
    fireEvent.input(nickBox(), { target: { value: 'not ok!' } });
    expect(screen.getByText(/Try “not_ok”/)).toBeTruthy();
    expect(joinButton().hasAttribute('disabled')).toBe(true);
    fireEvent.input(nickBox(), { target: { value: 'Wanderer' } });
    fireEvent.click(joinButton());
    expect(loadGuestSession()).toEqual({ nick: 'Wanderer' });
    expect(lastGuestNick()).toEqual({ nick: 'Wanderer', auto: false });
    cleanup();
    clearGuestSession();

    renderLogin();
    await screen.findByRole('button', { name: 'Join chat' });
    // A returning visitor keeps their nick.
    expect(nickBox().value).toBe('Wanderer');
    fireEvent.click(screen.getByRole('button', { name: 'Another nickname' }));
    expect(nickBox().value).not.toBe('Wanderer');
    fireEvent.click(joinButton());
    expect(lastGuestNick()?.auto).toBe(true);
  });

  it('remembers a made nick across visits', async () => {
    rememberGuestNick('ZestyKiwi', true);
    renderLogin();
    await screen.findByRole('button', { name: 'Join chat' });
    expect(nickBox().value).toBe('ZestyKiwi');
  });

  it('follows a link: ?nick= fills, ?channel= lands when allowed, ?join=1 joins without the click', async () => {
    __setGuestFirstLinkForTests({ nick: 'Wanderer', channel: '#help', join: true });
    renderLogin();
    await waitFor(() => expect(loadGuestSession()).toEqual({ nick: 'Wanderer' }));
    expect(takeGuestLanding()).toEqual({ focus: '#help', channels: ['#IRCForever'] });
  });

  it("doesn't land on a channel kept to roles", async () => {
    __setGuestFirstLinkForTests({ channel: '#staff' });
    renderLogin();
    expect(await screen.findByText('#IRCForever')).toBeTruthy();
    fireEvent.click(joinButton());
    expect(takeGuestLanding()?.focus).toBe('#IRCForever');
  });

  it('opens the full sign-in a click away, and comes back', async () => {
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('textbox', { name: 'Username or email' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Join as a guest instead' }));
    expect(await screen.findByRole('button', { name: 'Join chat' })).toBeTruthy();
  });

  it('is off without guest_first, or without guest access: the sign-in form as before', async () => {
    renderLogin({ guest_first: false });
    expect(await screen.findByRole('textbox', { name: 'Username or email' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join chat' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue without an account' })).toBeTruthy();
    cleanup();
    renderLogin({ guest_access: false });
    expect(await screen.findByRole('textbox', { name: 'Username or email' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join chat' })).toBeNull();
  });

  it("is boson.chat's own client: never guest-first", async () => {
    setHomeNetwork(null);
    renderLogin();
    expect(await screen.findByRole('textbox', { name: 'Username or email' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join chat' })).toBeNull();
  });
});
