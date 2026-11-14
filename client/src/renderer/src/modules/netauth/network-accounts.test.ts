import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { NetworkAccounts, sessionKeyFor, type NetAuthBridge } from './network-accounts';
import { isAccountRequired, isAccountRequiredText, isSaslFailure, resolveIrcLogin } from './irc-login';

const MAIN = 'https://auth.boson.chat';
const NET_A = 'https://auth.net-a.org';
const NET_B = 'https://auth.net-b.org';

function jwt(iss: string, n: number): string {
  return `h.${btoa(JSON.stringify({ iss, n }))}.s`;
}

// A fake of several auth services at once, routed by origin: each issues
// its own tokens and refresh tokens and records what it was sent.
function fakeAuthServers(opts: { config?: Record<string, unknown> } = {}) {
  const seen: Array<{ origin: string; path: string; auth?: string; body: unknown }> = [];
  let n = 0;
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    const body = req.body ? JSON.parse(String(req.body)) : null;
    seen.push({ origin: u.origin, path: u.pathname, auth: req.headers.Authorization, body });
    const ok = (v: unknown): ApiResponse => ({ status: 200, ok: true, statusText: 'OK', text: JSON.stringify(v) });
    const tokens = (user: string) => ok({
      access_token: jwt(u.origin, ++n), expires_in: 900, refresh_token: `rt-${u.host}-${n}`, session_id: `ses-${u.host}`,
      user: { id: `usr-${u.host}`, username: user, email: null, email_verified: true, role: 'user' },
    });
    switch (u.pathname) {
      case '/v1/login': return tokens((body as { login: string }).login);
      case '/v1/token/refresh': return tokens('refreshed');
      case '/v1/logout': return { status: 204, ok: true, statusText: 'No Content', text: '' };
      case '/v1/config': return ok({ registration: 'open', sso_providers: [], ...(opts.config ?? {}) });
      case '/v1/voice/token': return ok({ token: `voice-${u.host}`, expires_in: 300 });
      default: return { status: 404, ok: false, statusText: 'Not Found', text: '{}' };
    }
  });
  return { transport, seen };
}

function bridgeFor(map: Record<string, { authUrl?: string; main?: boolean; brandingUrl?: string }>): NetAuthBridge & { discover: ReturnType<typeof vi.fn> } {
  return {
    discover: vi.fn(async (host: string) => ({ host, main: false, ...(map[host] ?? {}) })),
  };
}

function memLocal() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

function setup(o: { config?: Record<string, unknown>; guest?: boolean } = {}) {
  const servers = fakeAuthServers({ config: o.config });
  const storage = new InMemorySecureStorage();
  const mainAuth = new AuthService(MAIN, { storage, transport: servers.transport });
  const bridge = bridgeFor({
    'irc.net-a.org': { authUrl: NET_A },
    'irc.net-b.org': { authUrl: NET_B + '/' },
    'irc.boson.chat': { authUrl: MAIN, main: true },
    'irc.branded.org': { brandingUrl: 'https://branded.org/theme.json' },
  });
  const local = memLocal();
  const accounts = new NetworkAccounts({
    mainAuthUrl: MAIN, mainAuth, storage, transport: servers.transport, bridge, local, isGuest: () => !!o.guest,
  });
  return { accounts, mainAuth, storage, bridge, local, ...servers };
}

describe('NetworkAccounts', () => {
  it("records a network's branding URL, with or without accounts", async () => {
    const { accounts } = setup();
    expect(await accounts.discover('IRC.branded.org')).toBeNull();
    expect(accounts.brandingUrlFor('irc.branded.org')).toBe('https://branded.org/theme.json');
    await accounts.discover('irc.net-a.org');
    expect(accounts.brandingUrlFor('irc.net-a.org')).toBeUndefined();
  });

  it('discovers a network once and remembers its auth service', async () => {
    const { accounts, bridge, local } = setup();
    const link = await accounts.discover('IRC.net-a.org');
    expect(link).toEqual({ host: 'irc.net-a.org', authUrl: NET_A, main: false });
    await accounts.discover('irc.net-a.org');
    expect(bridge.discover).toHaveBeenCalledTimes(1);
    expect(accounts.getSnapshot().known.map((k) => k.authUrl)).toEqual([NET_A]);
    expect(JSON.parse(local.getItem('boson.netauth.known')!)[0].hosts).toEqual(['irc.net-a.org']);
    expect(await accounts.discover('irc.plain.org')).toBeNull();
  });

  it("treats the app's own auth as the main account (not a network account)", async () => {
    const { accounts } = setup();
    const link = await accounts.discover('irc.boson.chat');
    expect(link?.main).toBe(true);
    expect(accounts.getSnapshot().known).toEqual([]);
    expect(accounts.service(MAIN)).toBe(accounts['opts'].mainAuth);
  });

  it('keeps one session per auth service, each under its own key', async () => {
    const { accounts, mainAuth, storage, seen } = setup();
    await mainAuth.signIn('main-user', 'pw');
    await accounts.discover('irc.net-a.org');
    await accounts.discover('irc.net-b.org');
    await accounts.service(NET_A).signIn('alice', 'pw-a');
    await accounts.service(NET_B).signIn('bob', 'pw-b');

    // Each sign-in went to its own origin.
    expect(seen.filter((r) => r.path === '/v1/login').map((r) => r.origin)).toEqual([MAIN, NET_A, NET_B]);
    // Stored separately; the main key untouched by the networks.
    const a = JSON.parse((await storage.get(sessionKeyFor(NET_A)))!);
    const b = JSON.parse((await storage.get(sessionKeyFor(NET_B)))!);
    const main = JSON.parse((await storage.get(AuthService.STORAGE_KEY))!);
    expect(a.refresh_token).toMatch(/^rt-auth\.net-a\.org/);
    expect(b.refresh_token).toMatch(/^rt-auth\.net-b\.org/);
    expect(main.refresh_token).toMatch(/^rt-auth\.boson\.chat/);

    // Tokens are each service's own.
    const linkA = accounts.linkFor('irc.net-a.org')!;
    const tokA = await accounts.ircToken(linkA);
    expect(JSON.parse(atob(tokA!.split('.')[1]!)).iss).toBe(NET_A);

    // Signing out of one leaves the others.
    await accounts.signOut(NET_A);
    expect(await storage.get(sessionKeyFor(NET_A))).toBeNull();
    expect(await storage.get(sessionKeyFor(NET_B))).not.toBeNull();
    expect(mainAuth.getState().session?.user.username).toBe('main-user');
    expect(seen.find((r) => r.path === '/v1/logout')?.origin).toBe(NET_A);
    expect(accounts.sessionFor(linkA)).toBeNull();
  });

  it('never sends one service its neighbour’s tokens', async () => {
    const { accounts, mainAuth, seen } = setup();
    await mainAuth.signIn('main-user', 'pw');
    await accounts.discover('irc.net-a.org');
    await accounts.service(NET_A).signIn('alice', 'pw');
    await accounts.service(NET_A).voiceToken(['room']);
    await mainAuth.voiceToken();
    for (const r of seen.filter((x) => x.auth)) {
      const iss = JSON.parse(atob(r.auth!.replace('Bearer ', '').split('.')[1]!)).iss;
      expect(iss).toBe(r.origin);
    }
  });

  it('refreshes a network session at launch and before a token expires', async () => {
    const { accounts, storage, seen, transport } = setup();
    await storage.set(sessionKeyFor(NET_A), JSON.stringify({ refresh_token: 'rt-saved', session_id: 's', user: { id: 'u', username: 'alice' } }));
    const local = memLocal();
    local.setItem('boson.netauth.known', JSON.stringify([{ authUrl: NET_A, name: 'Net A', hosts: ['irc.net-a.org'] }]));
    const again = new NetworkAccounts({
      mainAuthUrl: MAIN, mainAuth: new AuthService(MAIN, { storage, transport }), storage, transport,
      bridge: bridgeFor({ 'irc.net-a.org': { authUrl: NET_A } }), local,
    });
    await again.init();
    const refresh = seen.filter((r) => r.path === '/v1/token/refresh');
    expect(refresh).toHaveLength(1);
    expect(refresh[0]).toMatchObject({ origin: NET_A, body: { refresh_token: 'rt-saved' } });
    const link = again.linkFor('irc.net-a.org')!;
    expect(again.sessionFor(link)?.user.username).toBe('refreshed');
    expect(again.nameFor(NET_A)).toBe('Net A');
    void accounts;
  });

  it("a connect during launch waits for the network's saved session", async () => {
    const { storage, transport } = setup();
    await storage.set(sessionKeyFor(NET_A), JSON.stringify({ refresh_token: 'rt-saved', session_id: 's', user: { id: 'u', username: 'alice' } }));
    const local = memLocal();
    local.setItem('boson.netauth.known', JSON.stringify([{ authUrl: NET_A, name: 'Net A', hosts: ['irc.net-a.org'] }]));
    const again = new NetworkAccounts({
      mainAuthUrl: MAIN, mainAuth: new AuthService(MAIN, { storage, transport }), storage, transport,
      bridge: bridgeFor({ 'irc.net-a.org': { authUrl: NET_A } }), local,
    });
    const launching = again.init();
    // The launch's discovery has recorded the link; the restore hasn't
    // finished. A guest-mode restore connects right now.
    await Promise.resolve();
    await Promise.resolve();
    const login = await resolveIrcLogin(again, 'irc.net-a.org', { interactive: false, serverName: 'Net A' });
    expect(login).toMatchObject({ token: expect.any(String) });
    await launching;
  });

  it('reads guest_access (absent means allowed)', async () => {
    const open = setup();
    const linkA = (await open.accounts.discover('irc.net-a.org'))!;
    expect(await open.accounts.guestAllowed(linkA)).toBe(true);
    const closed = setup({ config: { guest_access: false, site_name: 'Net A' } });
    const linkB = (await closed.accounts.discover('irc.net-a.org'))!;
    expect(await closed.accounts.guestAllowed(linkB)).toBe(false);
    expect(closed.accounts.nameFor(NET_A)).toBe('Net A');
  });

  it('shows one sign-in dialog at a time and remembers a guest choice', async () => {
    const { accounts } = setup();
    const linkA = (await accounts.discover('irc.net-a.org'))!;
    const linkB = (await accounts.discover('irc.net-b.org'))!;
    const first = accounts.promptSignIn({ link: linkA, serverName: 'A', reason: 'connect', allowGuest: true });
    const second = accounts.promptSignIn({ link: linkB, serverName: 'B', reason: 'connect', allowGuest: true });
    expect(accounts.getSnapshot().prompt?.link.host).toBe('irc.net-a.org');
    accounts.resolvePrompt('guest');
    expect(await first).toBe('guest');
    expect(accounts.guestChosen('irc.net-a.org')).toBe(true);
    expect(accounts.getSnapshot().prompt?.link.host).toBe('irc.net-b.org');
    accounts.resolvePrompt('cancel');
    expect(await second).toBe('cancel');
    expect(accounts.getSnapshot().prompt).toBeNull();
  });
});

describe('resolveIrcLogin', () => {
  it('connects plain networks as before', async () => {
    const { accounts } = setup();
    expect(await resolveIrcLogin(accounts, 'irc.plain.org', { interactive: true, serverName: 'Plain' })).toEqual({ link: null });
    expect(await resolveIrcLogin(null, 'irc.net-a.org', { interactive: true, serverName: 'A' })).toEqual({ link: null });
  });

  it('logs in with the network account: its token, its username as nick', async () => {
    const { accounts } = setup();
    await accounts.discover('irc.net-a.org');
    await accounts.service(NET_A).signIn('alice', 'pw');
    const r = await resolveIrcLogin(accounts, 'irc.net-a.org', { interactive: false, serverName: 'A' });
    if (r === 'cancel') throw new Error('cancelled');
    expect(r.nick).toBe('alice');
    expect(JSON.parse(atob(r.token!.split('.')[1]!)).iss).toBe(NET_A);
  });

  it('asks a user who is signed out, and goes on as a guest when they choose', async () => {
    const { accounts } = setup();
    const p = resolveIrcLogin(accounts, 'irc.net-a.org', { interactive: true, serverName: 'A' });
    await vi.waitFor(() => expect(accounts.getSnapshot().prompt).not.toBeNull());
    expect(accounts.getSnapshot().prompt).toMatchObject({ reason: 'connect', allowGuest: true });
    accounts.resolvePrompt('guest');
    expect(await p).toEqual({ link: expect.objectContaining({ authUrl: NET_A }) });
    // Remembered: no dialog next time.
    const again = await resolveIrcLogin(accounts, 'irc.net-a.org', { interactive: true, serverName: 'A' });
    expect(again).toEqual({ link: expect.objectContaining({ authUrl: NET_A }) });
  });

  it('signs in from the dialog and uses the new session', async () => {
    const { accounts } = setup();
    const p = resolveIrcLogin(accounts, 'irc.net-a.org', { interactive: true, serverName: 'A' });
    await vi.waitFor(() => expect(accounts.getSnapshot().prompt).not.toBeNull());
    await accounts.service(NET_A).signIn('alice', 'pw');
    accounts.resolvePrompt('signed-in');
    const r = await p;
    expect(r !== 'cancel' && r.token).toBeTruthy();
  });

  it('offers no guest way in when the network takes no guests, and cancel means no connect', async () => {
    const { accounts } = setup({ config: { guest_access: false } });
    accounts.setGuestChosen('irc.net-a.org', true);
    const p = resolveIrcLogin(accounts, 'irc.net-a.org', { interactive: true, serverName: 'A' });
    await vi.waitFor(() => expect(accounts.getSnapshot().prompt).not.toBeNull());
    expect(accounts.getSnapshot().prompt).toMatchObject({ reason: 'required', allowGuest: false });
    accounts.resolvePrompt('cancel');
    expect(await p).toBe('cancel');
  });

  it("doesn't ask boson.chat guests again unless boson.chat takes no guests", async () => {
    const open = setup({ guest: true });
    expect(await resolveIrcLogin(open.accounts, 'irc.boson.chat', { interactive: true, serverName: 'boson' }))
      .toEqual({ link: expect.objectContaining({ main: true }) });
    const closed = setup({ guest: true, config: { guest_access: false } });
    const p = resolveIrcLogin(closed.accounts, 'irc.boson.chat', { interactive: true, serverName: 'boson' });
    await vi.waitFor(() => expect(closed.accounts.getSnapshot().prompt).toMatchObject({ allowGuest: false }));
    closed.accounts.resolvePrompt('cancel');
    expect(await p).toBe('cancel');
  });

  it('uses the boson.chat account on boson.chat networks, keeping the usual nick', async () => {
    const { accounts, mainAuth } = setup();
    await mainAuth.signIn('main-user', 'pw');
    const r = await resolveIrcLogin(accounts, 'irc.boson.chat', { interactive: true, serverName: 'boson' });
    if (r === 'cancel') throw new Error('cancelled');
    expect(r.nick).toBeUndefined();
    expect(JSON.parse(atob(r.token!.split('.')[1]!)).iss).toBe(MAIN);
  });

  it('connects as a guest once when asked to, even signed in', async () => {
    const { accounts } = setup();
    await accounts.discover('irc.net-a.org');
    await accounts.service(NET_A).signIn('alice', 'pw');
    const r = await resolveIrcLogin(accounts, 'irc.net-a.org', { interactive: true, serverName: 'A', guest: true });
    expect(r).toEqual({ link: expect.objectContaining({ authUrl: NET_A }) });
  });
});

describe('IRC refusals', () => {
  it('recognises "no guests" and SASL failures', () => {
    expect(isAccountRequired({ Kind: 'FAIL', Args: ['*', 'ACCOUNT_REQUIRED'], Message: 'You must log in with SASL to join this server' })).toBe(true);
    expect(isAccountRequired({ Kind: 'FAIL', Args: ['CHATHISTORY', 'INVALID_PARAMS'], Message: 'bad' })).toBe(false);
    expect(isAccountRequired({ Kind: 'PRIVMSG', Args: [], Message: 'ACCOUNT_REQUIRED' })).toBe(false);
    expect(isAccountRequiredText('ERROR :You must log in with SASL to join this server')).toBe(true);
    expect(isAccountRequiredText('connection refused')).toBe(false);
    expect(isSaslFailure({ Kind: '904' })).toBe(true);
    expect(isSaslFailure({ Kind: '001' })).toBe(false);
  });
});
