import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import { __resetDeepLinkForTests, subscribeAddServer, subscribeDeepLink, type JoinParams } from '../deep-link/deep-link';
import { loadGuestSession, clearGuestSession } from '../guest/guest';
import { NetworkAccounts, type NetAuthBridge, type ResolvedNetwork } from './network-accounts';
import {
  clearLastServer, enterToAddServer, enterWithServer, loadLastServer, normalizeServerAddress, outcomeOf, resolveOtherServer, saveLastServer,
} from './other-server';

const NET = 'https://auth.selfhost.org';

function memLocal() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

function accountsWith(bridge: NetAuthBridge | null) {
  const storage = new InMemorySecureStorage();
  const transport = vi.fn(async () => ({ status: 404, ok: false, statusText: 'Not Found', text: '{}' }));
  return new NetworkAccounts({
    mainAuthUrl: 'https://auth.boson.chat',
    mainAuth: new AuthService('https://auth.boson.chat', { storage, transport }),
    storage, transport, bridge, local: memLocal(),
  });
}

describe('normalizeServerAddress', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  Example.COM. ', 'example.com'],
    ['irc.example.com', 'irc.example.com'],
    ['irc.example.com:6697', 'irc.example.com'],
    ['https://example.com/', 'example.com'],
    ['https://Chat.Example.com:8443/x?y', 'chat.example.com'],
    ['ircs://irc.example.com:6697', 'irc.example.com'],
    ['irc://irc.example.com', 'irc.example.com'],
    ['example.com/some/path', 'example.com'],
    ['localhost', 'localhost'],
  ])('%s → %s', (input, want) => {
    expect(normalizeServerAddress(input)).toBe(want);
  });

  it.each(['', '   ', 'ftp://example.com', 'https://user:pw@example.com', 'exa mple.com', '-bad.com', 'a..b', 'ex_ample.com'])('refuses %j', (input) => {
    expect(normalizeServerAddress(input)).toBeNull();
  });
});

describe('outcomeOf (discovery errors)', () => {
  const irc = { host: 'irc.selfhost.org', port: 6697, tls: true };
  it('a network with accounts becomes a sign-in on its IRC host', () => {
    expect(outcomeOf('selfhost.org', { host: 'selfhost.org', domain: 'selfhost.org', irc, authUrl: NET, main: false })).toEqual({
      kind: 'ok', address: 'selfhost.org', domain: 'selfhost.org', irc, link: { host: 'irc.selfhost.org', authUrl: NET, main: false },
    });
  });
  it("boson.chat is the app's own", () => {
    expect(outcomeOf('boson.chat', { host: 'boson.chat', irc, authUrl: 'https://auth.boson.chat', main: true }).kind).toBe('main');
  });
  it.each<[string, Partial<ResolvedNetwork>, string, RegExp]>([
    ['not found', { error: 'unreachable' }, 'error', /Couldn't reach x\.org/],
    ['no boson.json', { error: 'no-boson-json' }, 'error', /isn't a Boson network.*plain IRC server/],
    ['no accounts', { error: 'no-accounts', domain: 'x.org', irc }, 'no-accounts', /doesn't have accounts/],
    ['untrusted auth', { error: 'untrusted', domain: 'x.org', detail: 'private address', irc }, 'no-accounts', /won't use \(private address\)/],
    ['no irc', { error: 'no-irc', domain: 'x.org' }, 'error', /doesn't say where its IRC server is/],
    ['invalid', { error: 'invalid' }, 'error', /Enter a server address/],
  ])('%s', (_name, r, kind, message) => {
    const out = outcomeOf('x.org', { host: 'x.org', main: false, ...r });
    expect(out.kind).toBe(kind);
    expect((out as { message: string }).message).toMatch(message);
  });
  it('offers a plain IRC add when the address may still be an IRC server', () => {
    expect(outcomeOf('x.org', { host: 'x.org', main: false, error: 'no-boson-json' })).toMatchObject({ plainIrc: true });
    expect(outcomeOf('x.org', { host: 'x.org', main: false, error: 'invalid' })).toMatchObject({ plainIrc: false });
  });
});

describe('resolveOtherServer', () => {
  it('validates before asking the shell, and links the network for the connect', async () => {
    const resolve = vi.fn(async (address: string): Promise<ResolvedNetwork> => ({
      host: address, domain: 'selfhost.org', irc: { host: 'irc.selfhost.org', port: 6697, tls: true }, authUrl: NET + '/', main: false,
    }));
    const accounts = accountsWith({ discover: vi.fn(), resolve });
    expect((await resolveOtherServer(accounts, 'not a host')).kind).toBe('error');
    expect(resolve).not.toHaveBeenCalled();

    const out = await resolveOtherServer(accounts, 'https://SelfHost.org/');
    expect(resolve).toHaveBeenCalledWith('selfhost.org');
    expect(out.kind).toBe('ok');
    // The IRC host's discovery is answered: the connect finds this auth.
    expect(accounts.linkFor('irc.selfhost.org')).toEqual({ host: 'irc.selfhost.org', authUrl: NET, main: false });
    expect(accounts.getSnapshot().known.map((k) => k.authUrl)).toEqual([NET]);
  });

  it('says so when the shell has no lookup, or it fails', async () => {
    expect(await resolveOtherServer(accountsWith({ discover: vi.fn() }), 'x.org')).toMatchObject({ kind: 'error', message: expect.stringMatching(/can't look up/) });
    expect(await resolveOtherServer(null, 'x.org')).toMatchObject({ kind: 'error' });
    const failing = accountsWith({ discover: vi.fn(), resolve: vi.fn(async () => { throw new Error('boom'); }) });
    expect(await resolveOtherServer(failing, 'x.org')).toMatchObject({ kind: 'error', plainIrc: true, message: expect.stringMatching(/didn't answer/) });
  });

  it("doesn't link a network without accounts", async () => {
    const accounts = accountsWith({ discover: vi.fn(), resolve: vi.fn(async () => ({ host: 'plain.org', irc: { host: 'irc.plain.org', port: 6697, tls: true }, main: false, error: 'no-accounts' })) });
    expect((await resolveOtherServer(accounts, 'plain.org')).kind).toBe('no-accounts');
    expect(accounts.linkFor('irc.plain.org')).toBeNull();
  });
});

describe('last server and entering the app', () => {
  beforeEach(() => { localStorage.clear(); __resetDeepLinkForTests(); });
  afterEach(() => { clearGuestSession(); __resetDeepLinkForTests(); });

  it('round-trips the last server and ignores junk', () => {
    const s = { address: 'selfhost.org', name: 'Selfhost', irc: { host: 'irc.selfhost.org', port: 6697, tls: true }, authUrl: NET };
    saveLastServer(s);
    expect(loadLastServer()).toEqual(s);
    clearLastServer();
    expect(loadLastServer()).toBeNull();
    localStorage.setItem('boson.login.lastServer', '{"address":1}');
    expect(loadLastServer()).toBeNull();
  });

  it('enters guest mode as the account, joins the network and remembers it', () => {
    const accounts = accountsWith({ discover: vi.fn() });
    const joins: JoinParams[] = [];
    const server = { address: 'selfhost.org', name: 'Selfhost', irc: { host: 'irc.selfhost.org', port: 6697, tls: true }, authUrl: NET };
    enterWithServer({ accounts, server, nick: 'alice', asGuest: false });
    // Buffered until the directory screen subscribes.
    subscribeDeepLink((p) => joins.push(p));
    expect(joins).toEqual([{ host: 'irc.selfhost.org', port: 6697, tls: true, name: 'Selfhost' }]);
    expect(loadGuestSession()).toEqual({ nick: 'alice' });
    expect(loadLastServer()).toEqual(server);
    expect(accounts.guestChosen('irc.selfhost.org')).toBe(false);

    enterWithServer({ accounts, server, nick: 'bob', asGuest: true });
    expect(accounts.guestChosen('irc.selfhost.org')).toBe(true);
  });

  it('a plain IRC server opens the manual add with its host', () => {
    const adds: string[] = [];
    enterToAddServer('carol', 'irc.plain.org');
    subscribeAddServer((p) => adds.push(p.hostname));
    expect(adds).toEqual(['irc.plain.org']);
    expect(loadGuestSession()).toEqual({ nick: 'carol' });
  });
});
