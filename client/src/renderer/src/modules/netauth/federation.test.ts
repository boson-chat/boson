import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { ApiRequest, ApiResponse } from '../../shared/http/transport';
import { NetworkAccounts, mainDomainOf, sessionKeyFor, type NetAuthBridge } from './network-accounts';
import { resolveIrcLogin } from './irc-login';
import { setHomeNetwork } from './home-network';
import {
  FederationError, acceptsFederation, cleanFederation, describeFederationError, homeDomainOf, issuesAssertions, retryable,
  type FederationErrorCode,
} from './federation';

const MAIN = 'https://auth.boson.chat';
const HOME_B = 'https://auth.home-b.org';
const REMOTE = 'https://auth.remote.org';

function fed(domain: string, accepts = 'directory') {
  const base = `https://auth.${domain}`;
  return {
    version: 1,
    issuer: base,
    jwks_uri: `${base}/.well-known/jwks.json`,
    assertion_endpoint: `${base}/v1/federation/assertions`,
    login_endpoint: `${base}/v1/federation/login`,
    accepts,
    domain,
  };
}

const json = (status: number, v: unknown): ApiResponse => ({
  status, ok: status >= 200 && status < 300, statusText: String(status), text: JSON.stringify(v),
});

// Fakes of the home auth services (assertions) and the remote's (login),
// routed by origin. remoteError / homeError make one side refuse.
function fakeServers(o: { remoteError?: { status: number; error: string }; homeError?: { status: number; error: string }; handle?: string } = {}) {
  const seen: Array<{ origin: string; path: string; auth?: string; body: Record<string, unknown> | null }> = [];
  let n = 0;
  const transport = vi.fn(async (req: ApiRequest): Promise<ApiResponse> => {
    const u = new URL(req.url);
    const body = req.body ? JSON.parse(String(req.body)) as Record<string, unknown> : null;
    seen.push({ origin: u.origin, path: u.pathname, auth: req.headers.Authorization, body });
    const tokens = (username: string, extra: Record<string, unknown> = {}) => json(200, {
      access_token: `at-${u.host}-${++n}`, expires_in: 900, refresh_token: `rt-${u.host}-${n}`, session_id: `ses-${u.host}`,
      user: { id: `usr-${u.host}`, username, email: null, email_verified: true, role: 'user' }, ...extra,
    });
    switch (u.pathname) {
      case '/v1/login': return tokens(String(body?.login));
      case '/v1/token/refresh': return tokens(o.handle ?? 'alice');
      case '/v1/logout': return json(204, {});
      case '/v1/federation/assertions': {
        if (o.homeError) return json(o.homeError.status, { error: o.homeError.error, message: 'no' });
        if (!req.headers.Authorization) return json(401, { error: 'unauthorized' });
        return json(200, { assertion: `assert:${u.host}:${String(body?.audience)}:${req.headers.Authorization}`, expires_in: 300 });
      }
      case '/v1/federation/login': {
        if (o.remoteError) return json(o.remoteError.status, { error: o.remoteError.error, message: 'refused' });
        const a = String(body?.assertion ?? '');
        const home = a.split(':')[1] ?? '';
        const domain = home.replace(/^auth\./, '');
        const handle = o.handle ?? 'alice';
        return tokens(handle, { federated: true, identity: `alice@${domain}`, handle });
      }
      default: return json(404, {});
    }
  });
  return { transport, seen };
}

function memLocal() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

function setup(o: Parameters<typeof fakeServers>[0] & { guest?: boolean; remoteAccepts?: string; mainFed?: boolean } = {}) {
  const servers = fakeServers(o);
  const storage = new InMemorySecureStorage();
  const mainAuth = new AuthService(MAIN, { storage, transport: servers.transport });
  const map: Record<string, Record<string, unknown>> = {
    'boson.chat': { authUrl: MAIN, main: true, ...(o.mainFed === false ? {} : { federation: fed('boson.chat') }) },
    'irc.boson.chat': { authUrl: MAIN, main: true, federation: fed('boson.chat') },
    'irc.home-b.org': { authUrl: HOME_B, federation: fed('home-b.org', 'off') },
    'irc.remote.org': { authUrl: REMOTE, federation: fed('remote.org', o.remoteAccepts ?? 'directory') },
    'irc.plain.org': { authUrl: 'https://auth.plain.org' },
  };
  const bridge: NetAuthBridge & { discover: ReturnType<typeof vi.fn> } = {
    discover: vi.fn(async (host: string) => ({ host, main: false, ...(map[host] ?? {}) })),
  };
  const local = memLocal();
  const accounts = new NetworkAccounts({
    mainAuthUrl: MAIN, mainAuth, storage, transport: servers.transport, bridge, local, isGuest: () => !!o.guest,
  });
  return { accounts, mainAuth, storage, bridge, local, ...servers };
}

describe('cleanFederation', () => {
  it('reads a valid block', () => {
    expect(cleanFederation(fed('x.org'))).toEqual(fed('x.org'));
    expect(cleanFederation({ version: 1, issuer: 'https://auth.x.org/' })).toEqual({ version: 1, issuer: 'https://auth.x.org', accepts: 'off' });
  });
  it.each([
    ['not an object', 'nope'],
    ['version', { ...fed('x.org'), version: 2 }],
    ['mode', { ...fed('x.org'), accepts: 'everyone' }],
    ['http issuer', { ...fed('x.org'), issuer: 'http://auth.x.org' }],
    ['endpoint on another origin', { ...fed('x.org'), assertion_endpoint: 'https://evil.org/a' }],
    ['endpoint with a query', { ...fed('x.org'), login_endpoint: 'https://auth.x.org/login?x=1' }],
  ])('refuses %s', (_name, raw) => {
    expect(cleanFederation(raw)).toBeNull();
  });
  it('allows loopback http only when asked', () => {
    const dev = { version: 1, issuer: 'http://127.0.0.1:8080', login_endpoint: 'http://127.0.0.1:8080/v1/federation/login', accepts: 'open' };
    expect(cleanFederation(dev)).toBeNull();
    expect(cleanFederation(dev, true)?.login_endpoint).toBe('http://127.0.0.1:8080/v1/federation/login');
  });
  it('says who accepts and who issues', () => {
    expect(acceptsFederation(cleanFederation(fed('x.org')), 'https://auth.x.org')).toBe(true);
    expect(acceptsFederation(cleanFederation(fed('x.org', 'off')))).toBe(false);
    expect(acceptsFederation(cleanFederation(fed('x.org')), 'https://auth.other.org')).toBe(false);
    expect(issuesAssertions(cleanFederation(fed('x.org')))).toBe(true);
    expect(issuesAssertions(null)).toBe(false);
    expect(homeDomainOf('alice@boson.chat')).toBe('boson.chat');
    expect(homeDomainOf('alice')).toBe('');
    expect(mainDomainOf('https://auth.boson.chat')).toBe('boson.chat');
  });
});

describe('federated sign-in', () => {
  it("a self-hosted web client in guest mode signs in to its own network with alice@boson.chat, and IRC gets that network's token", async () => {
    const SELF = 'https://auth.boson.ircforever.org';
    setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRC Forever', selfHosted: true });
    try {
      const servers = fakeServers({ handle: 'alice' });
      const storage = new InMemorySecureStorage();
      const mainAuth = new AuthService(SELF, { storage, transport: servers.transport });
      const map: Record<string, Record<string, unknown>> = {
        'irc.boson.ircforever.org': { authUrl: SELF, main: true, federation: fed('boson.ircforever.org') },
        'irc.boson.chat': { authUrl: MAIN, federation: fed('boson.chat') },
      };
      const discover = vi.fn(async (host: string) => ({ host, main: false, ...(map[host] ?? {}) }));
      // Came in through "Use another server" → boson.chat: guest mode, with
      // a boson.chat network session.
      const accounts = new NetworkAccounts({
        mainAuthUrl: SELF, mainAuth, storage, transport: servers.transport, bridge: { discover }, local: memLocal(), isGuest: () => true,
      });
      expect(accounts.mainAsNetwork()).toBe(true);
      await accounts.discover('irc.boson.chat');
      await accounts.service(MAIN).signIn('alice', 'pw');

      // Connecting to the install's own IRC: no install session yet, so it
      // asks (never a credential-less connect the bridge answers with 464).
      const home = (await accounts.discover('irc.boson.ircforever.org'))!;
      expect(home.main).toBe(true);
      expect(accounts.sessionFor(home)).toBeNull();
      const login = resolveIrcLogin(accounts, 'irc.boson.ircforever.org', { interactive: true, serverName: 'IRC Forever' });
      await vi.waitFor(() => expect(accounts.getSnapshot().prompt?.link.host).toBe('irc.boson.ircforever.org'));

      // The prompt offers "Continue as alice@boson.chat".
      const homes = await accounts.homeAccounts(home);
      expect(homes.map((h) => h.identity)).toEqual(['alice@boson.chat']);
      await accounts.signInFederated(home, homes[0]!);
      accounts.resolvePrompt('signed-in');
      const r = await login;
      expect(r).toMatchObject({ link: { host: 'irc.boson.ircforever.org' }, nick: 'alice' });
      expect((r as { token?: string }).token).toMatch(/^at-auth\.boson\.ircforever\.org-/);
      // The assertion went to the install's own federation login, and the
      // app's guest mode (no main session) is left alone.
      expect(servers.seen.some((x) => x.origin === SELF && x.path === '/v1/federation/login')).toBe(true);
      expect(mainAuth.getState().session).toBeNull();
      expect(accounts.sessionFor(home)?.federated?.identity).toBe('alice@boson.chat');
    } finally {
      setHomeNetwork(null);
    }
  });

  it("boson.chat's own client in guest mode still connects its own network as a guest without asking", async () => {
    const { accounts } = setup({ guest: true });
    expect(accounts.mainAsNetwork()).toBe(false);
    expect(await resolveIrcLogin(accounts, 'irc.boson.chat', { interactive: true, serverName: 'boson' })).toEqual({ link: expect.objectContaining({ main: true }) });
    expect(accounts.getSnapshot().prompt).toBeNull();
  });

  it("offers a self-hosted web client's own account as alice@<its domain>", async () => {
    const SELF = 'https://auth.boson.ircforever.org';
    setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRC Forever', selfHosted: true });
    try {
      const servers = fakeServers();
      const storage = new InMemorySecureStorage();
      const mainAuth = new AuthService(SELF, { storage, transport: servers.transport });
      const map: Record<string, Record<string, unknown>> = {
        // Its boson.json is at boson.ircforever.org, which discovery finds
        // for the auth host (a lookup of boson.ircforever.org itself would
        // go to ircforever.org).
        'auth.boson.ircforever.org': { authUrl: SELF, main: true, federation: fed('boson.ircforever.org') },
        'irc.boson.chat': { authUrl: MAIN, federation: fed('boson.chat') },
      };
      const discover = vi.fn(async (host: string) => ({ host, main: false, ...(map[host] ?? {}) }));
      const accounts = new NetworkAccounts({ mainAuthUrl: SELF, mainAuth, storage, transport: servers.transport, bridge: { discover }, local: memLocal() });
      await mainAuth.signIn('alice', 'pw');
      const bosonChat = (await accounts.discover('irc.boson.chat'))!;
      expect(bosonChat.main).toBe(false);
      const homes = await accounts.homeAccounts(bosonChat);
      expect(discover).toHaveBeenCalledWith('auth.boson.ircforever.org', false);
      expect(homes).toEqual([expect.objectContaining({ main: true, identity: 'alice@boson.ircforever.org', name: 'IRC Forever', authUrl: SELF })]);
    } finally {
      setHomeNetwork(null);
    }
  });

  it('offers the boson.chat account on a server that accepts accounts from elsewhere', async () => {
    const { accounts, mainAuth } = setup();
    await mainAuth.signIn('alice', 'pw');
    const remote = (await accounts.discover('irc.remote.org'))!;
    expect(remote.federation?.accepts).toBe('directory');
    const homes = await accounts.homeAccounts(remote);
    expect(homes.map((h) => h.identity)).toEqual(['alice@boson.chat']);
    expect(homes[0]).toMatchObject({ main: true, domain: 'boson.chat', authUrl: MAIN });
  });

  it('offers nothing when the remote is off, has no federation, or nobody is signed in', async () => {
    const off = setup({ remoteAccepts: 'off' });
    await off.mainAuth.signIn('alice', 'pw');
    expect(await off.accounts.homeAccounts((await off.accounts.discover('irc.remote.org'))!)).toEqual([]);

    const plain = setup();
    await plain.mainAuth.signIn('alice', 'pw');
    expect(await plain.accounts.homeAccounts((await plain.accounts.discover('irc.plain.org'))!)).toEqual([]);

    const nobody = setup();
    expect(await nobody.accounts.homeAccounts((await nobody.accounts.discover('irc.remote.org'))!)).toEqual([]);

    // A guest's main account doesn't count, nor one whose server has no
    // federation block.
    const guest = setup({ guest: true });
    await guest.mainAuth.signIn('alice', 'pw');
    expect(await guest.accounts.homeAccounts((await guest.accounts.discover('irc.remote.org'))!)).toEqual([]);
    const noFed = setup({ mainFed: false });
    await noFed.mainAuth.signIn('alice', 'pw');
    expect(await noFed.accounts.homeAccounts((await noFed.accounts.discover('irc.remote.org'))!)).toEqual([]);
  });

  it('lists every home account (one choice each), never the remote itself', async () => {
    const { accounts, mainAuth, bridge } = setup();
    // home-b issues assertions even though it accepts none itself.
    bridge.discover.mockImplementation(async (host: string) => {
      if (host === 'irc.home-b.org') return { host, main: false, authUrl: HOME_B, federation: { ...fed('home-b.org', 'off'), accepts: 'open' } };
      if (host === 'irc.remote.org') return { host, main: false, authUrl: REMOTE, federation: fed('remote.org') };
      if (host === 'boson.chat') return { host, main: true, authUrl: MAIN, federation: fed('boson.chat') };
      return { host, main: false };
    });
    await mainAuth.signIn('alice', 'pw');
    await accounts.discover('irc.home-b.org');
    await accounts.service(HOME_B).signIn('al', 'pw');
    const remote = (await accounts.discover('irc.remote.org'))!;
    await accounts.service(REMOTE).signIn('local-alice', 'pw');
    const homes = await accounts.homeAccounts(remote);
    expect(homes.map((h) => h.identity)).toEqual(['alice@boson.chat', 'al@home-b.org']);
  });

  it("doesn't offer a home whose server stopped issuing (accepts: off)", async () => {
    const { accounts, mainAuth } = setup();
    await mainAuth.signIn('alice', 'pw');
    await accounts.discover('irc.home-b.org');
    await accounts.service(HOME_B).signIn('al', 'pw');
    const homes = await accounts.homeAccounts((await accounts.discover('irc.remote.org'))!);
    expect(homes.map((h) => h.identity)).toEqual(['alice@boson.chat']);
  });

  it('asserts at home for the remote issuer, logs in at the remote, stores a federated session', async () => {
    const { accounts, mainAuth, seen, storage } = setup();
    await mainAuth.signIn('alice', 'pw');
    const homeToken = mainAuth.getState().session!.access_token;
    const remote = (await accounts.discover('irc.remote.org'))!;
    const [home] = await accounts.homeAccounts(remote);
    const session = await accounts.signInFederated(remote, home!);

    const assert = seen.find((s) => s.path === '/v1/federation/assertions')!;
    expect(assert.origin).toBe(MAIN);
    expect(assert.auth).toBe(`Bearer ${homeToken}`);
    expect(assert.body).toEqual({ audience: REMOTE });
    const login = seen.find((s) => s.path === '/v1/federation/login')!;
    expect(login.origin).toBe(REMOTE);
    expect(login.auth).toBeUndefined();
    expect(String(login.body?.assertion)).toContain(`assert:auth.boson.chat:${REMOTE}`);

    expect(session.federated).toEqual({ identity: 'alice@boson.chat', handle: 'alice', homeAuthUrl: MAIN, homeDomain: 'boson.chat' });
    expect(accounts.sessionFor(remote)?.federated?.identity).toBe('alice@boson.chat');
    // Kept under the remote's own key, with where it came from.
    const saved = JSON.parse((await storage.get(sessionKeyFor(REMOTE)))!);
    expect(saved.federated.identity).toBe('alice@boson.chat');
    expect(saved.refresh_token).toMatch(/^rt-auth\.remote\.org/);
    expect(accounts.guestChosen('irc.remote.org')).toBe(false);
  });

  it('logs in to IRC with the remote token, nick = the returned handle', async () => {
    const { accounts, mainAuth } = setup({ handle: 'alice-bosonchat' });
    await mainAuth.signIn('alice', 'pw');
    const remote = (await accounts.discover('irc.remote.org'))!;
    await accounts.signInFederated(remote, (await accounts.homeAccounts(remote))[0]!);
    const login = await resolveIrcLogin(accounts, 'irc.remote.org', { interactive: false, serverName: 'Remote' });
    expect(login).toMatchObject({ nick: 'alice-bosonchat' });
    expect((login as { token: string }).token).toMatch(/^at-auth\.remote\.org/);
  });

  it('refreshes the remote session itself and keeps it federated', async () => {
    const { accounts, mainAuth, seen } = setup();
    await mainAuth.signIn('alice', 'pw');
    const remote = (await accounts.discover('irc.remote.org'))!;
    await accounts.signInFederated(remote, (await accounts.homeAccounts(remote))[0]!);
    const svc = accounts.service(REMOTE);
    const refreshed = await svc.refresh();
    expect(seen.filter((s) => s.path === '/v1/token/refresh').map((s) => s.origin)).toEqual([REMOTE]);
    expect(refreshed?.federated?.identity).toBe('alice@boson.chat');
  });

  it('restores a federated session from the keychain', async () => {
    const a = setup();
    await a.mainAuth.signIn('alice', 'pw');
    const remote = (await a.accounts.discover('irc.remote.org'))!;
    await a.accounts.signInFederated(remote, (await a.accounts.homeAccounts(remote))[0]!);
    const again = new AuthService(REMOTE, { storage: a.storage, storageKey: sessionKeyFor(REMOTE), transport: a.transport });
    await again.init();
    expect(again.getState().session?.federated?.handle).toBe('alice');
  });

  it('keeps the remote session when the home account signs out, and says so', async () => {
    const { accounts, bridge } = setup();
    bridge.discover.mockImplementation(async (host: string) => {
      if (host === 'irc.home-b.org') return { host, main: false, authUrl: HOME_B, federation: { ...fed('home-b.org'), accepts: 'open' } };
      if (host === 'irc.remote.org') return { host, main: false, authUrl: REMOTE, federation: fed('remote.org') };
      return { host, main: false };
    });
    await accounts.discover('irc.home-b.org');
    await accounts.service(HOME_B).signIn('al', 'pw');
    const remote = (await accounts.discover('irc.remote.org'))!;
    const [home] = await accounts.homeAccounts(remote);
    expect(home?.identity).toBe('al@home-b.org');
    const session = await accounts.signInFederated(remote, home!);
    expect(accounts.homeSignedIn(session)).toBe(true);
    expect(accounts.linkedTo(HOME_B).map((l) => l.authUrl)).toEqual([REMOTE]);

    await accounts.signOut(HOME_B);
    expect(accounts.sessionFor(remote)?.federated?.identity).toBe('alice@home-b.org');
    expect(accounts.homeSignedIn(accounts.sessionFor(remote)!)).toBe(false);
    expect(await accounts.ircToken(remote)).toMatch(/^at-auth\.remote\.org/);
  });

  it('never sends the home token off its own origin', async () => {
    const { accounts, mainAuth, seen } = setup();
    await mainAuth.signIn('alice', 'pw');
    await expect(mainAuth.federationAssertion('https://evil.org/v1/federation/assertions', REMOTE))
      .rejects.toMatchObject({ code: 'foreign_endpoint' });
    expect(seen.some((s) => s.origin === 'https://evil.org')).toBe(false);
    void accounts;
  });

  const remoteCodes: FederationErrorCode[] = [
    'federation_off', 'domain_not_trusted', 'domain_blocked', 'identity_banned', 'discovery_failed', 'bad_assertion', 'replayed',
  ];
  it.each(remoteCodes)('maps the remote refusing with %s to a clear message', async (code) => {
    const { accounts, mainAuth } = setup({ remoteError: { status: code === 'discovery_failed' ? 502 : 403, error: code } });
    await mainAuth.signIn('alice', 'pw');
    const remote = (await accounts.discover('irc.remote.org'))!;
    const [home] = await accounts.homeAccounts(remote);
    const err = await accounts.signInFederated(remote, home!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FederationError);
    expect((err as FederationError).code).toBe(code);
    expect((err as FederationError).side).toBe('remote');
    const msg = describeFederationError(err, { remote: 'Remote', identity: 'alice@boson.chat', homeDomain: 'boson.chat', accepts: 'directory' });
    expect(msg).toMatch(/\.$/);
    expect(msg).not.toMatch(/refused/);
    expect(accounts.sessionFor(remote)).toBeNull();
  });

  it('words the trust refusals by mode', () => {
    const err = new FederationError('domain_not_trusted', 'remote', 'x', 403);
    const c = { remote: 'Remote', identity: 'alice@boson.chat', homeDomain: 'boson.chat' };
    expect(describeFederationError(err, { ...c, accepts: 'directory' })).toMatch(/^This server only accepts accounts from verified Boson servers/);
    expect(describeFederationError(err, { ...c, accepts: 'allowlist' })).toMatch(/admins have approved/);
    expect(describeFederationError(new FederationError('identity_banned', 'remote', ''), c)).toBe('alice@boson.chat is banned on Remote.');
    expect(describeFederationError(new FederationError('domain_blocked', 'remote', ''), c)).toBe("Remote doesn't accept accounts from boson.chat.");
    expect(retryable(new FederationError('replayed', 'remote', ''))).toBe(true);
    expect(retryable(new FederationError('domain_blocked', 'remote', ''))).toBe(false);
  });

  it.each([
    [{ status: 403, error: 'guest_not_allowed' }, 'home_refused', /won't vouch/],
    [{ status: 401, error: 'unauthorized' }, 'home_signed_out', /sign-in has ended/],
    [{ status: 404, error: 'not_found' }, 'home_unsupported', /can't sign you in to other servers/],
    [{ status: 429, error: 'rate_limited' }, 'rate_limited', /Too many attempts/],
  ] as const)('maps the home refusing (%o) to %s', async (homeError, code, wording) => {
    const { accounts, mainAuth, seen } = setup({ homeError });
    await mainAuth.signIn('alice', 'pw');
    const remote = (await accounts.discover('irc.remote.org'))!;
    const [home] = await accounts.homeAccounts(remote);
    const err = await accounts.signInFederated(remote, home!).catch((e: unknown) => e);
    expect(err).toMatchObject({ code, side: 'home' });
    expect(describeFederationError(err, { remote: 'Remote', identity: 'alice@boson.chat', homeDomain: 'boson.chat' })).toMatch(wording);
    // The remote never saw anything.
    expect(seen.some((s) => s.path === '/v1/federation/login')).toBe(false);
  });

  it('a network failure on either side says which', async () => {
    const { accounts, mainAuth, transport } = setup();
    await mainAuth.signIn('alice', 'pw');
    const remote = (await accounts.discover('irc.remote.org'))!;
    const [home] = await accounts.homeAccounts(remote);
    const real = transport.getMockImplementation()!;
    transport.mockImplementation(async (req: ApiRequest) => {
      if (req.url.includes('/v1/federation/login')) throw new Error('offline');
      return real(req);
    });
    const err = await accounts.signInFederated(remote, home!).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'network', side: 'remote' });
    expect(describeFederationError(err, { remote: 'Remote', identity: home!.identity, homeDomain: 'boson.chat' })).toMatch(/Couldn't reach Remote/);
  });
});
