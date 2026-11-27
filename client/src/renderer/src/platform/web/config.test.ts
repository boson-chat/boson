import { describe, expect, it, vi } from 'vitest';
import { homeNetworkOf } from './config';
import { NetworkDiscoverer } from './discovery';
import { BOSON_CHAT_HOME } from '../../modules/netauth/home-network';

describe('homeNetworkOf: whose web client this is', () => {
  it("is boson.chat's for boson.chat's auth service, or none given", () => {
    expect(homeNetworkOf({ authUrl: 'https://auth.boson.chat' })).toBe(BOSON_CHAT_HOME);
    expect(homeNetworkOf({})).toBe(BOSON_CHAT_HOME);
    expect(homeNetworkOf({}, 'https://auth.boson.chat')).toBe(BOSON_CHAT_HOME);
  });

  it("is a self-hosted network's when its auth service is on another domain (today's stack config)", () => {
    expect(homeNetworkOf({
      authUrl: 'https://auth.boson.ircforever.org', apiUrl: 'https://api.boson.ircforever.org', directoryUrl: 'https://directory.boson.chat',
    })).toEqual({ domain: 'boson.ircforever.org', name: 'boson.ircforever.org', selfHosted: true });
    expect(homeNetworkOf({ authUrl: 'https://auth.example.org/' })).toMatchObject({ domain: 'example.org', selfHosted: true });
  });

  it('takes an explicit domain and name (BOSON_NETWORK_DOMAIN / BOSON_NETWORK_NAME)', () => {
    expect(homeNetworkOf({ authUrl: 'https://login.example.org', networkDomain: 'Chat.Example.org.', networkName: '  Example  ' }))
      .toEqual({ domain: 'chat.example.org', name: 'Example', selfHosted: true });
    // Saying boson.chat is boson.chat.
    expect(homeNetworkOf({ authUrl: 'https://auth.example.org', networkDomain: 'boson.chat' })).toBe(BOSON_CHAT_HOME);
    // Not a domain: ignored, the auth service's is used.
    expect(homeNetworkOf({ authUrl: 'https://auth.example.org', networkDomain: 'not a domain' })).toMatchObject({ domain: 'example.org' });
    expect(homeNetworkOf({ authUrl: 'https://auth.boson.chat', networkDomain: '', networkName: 'X' })).toBe(BOSON_CHAT_HOME);
  });

  it('keeps dev and e2e stacks on loopback as boson.chat unless told otherwise', () => {
    expect(homeNetworkOf({ authUrl: 'http://127.0.0.1:18080' })).toBe(BOSON_CHAT_HOME);
    expect(homeNetworkOf({ authUrl: 'http://localhost:8080' })).toBe(BOSON_CHAT_HOME);
    expect(homeNetworkOf({ authUrl: 'http://auth.localhost' })).toBe(BOSON_CHAT_HOME);
    expect(homeNetworkOf({ authUrl: 'not a url' })).toBe(BOSON_CHAT_HOME);
    expect(homeNetworkOf({ authUrl: 'http://127.0.0.1:18080', networkDomain: 'selfhost.test' })).toMatchObject({ domain: 'selfhost.test', selfHosted: true });
  });
});

describe('NetworkDiscoverer.home', () => {
  const doc = { version: 1, irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true }, auth: { url: 'https://auth.boson.ircforever.org' } };

  it("reads the network's boson.json at its own domain (not its parent's), cached", async () => {
    const fetch = vi.fn(async (_u: string) => new Response(JSON.stringify(doc), { status: 200 }));
    const d = new NetworkDiscoverer({ fetch: fetch as unknown as typeof globalThis.fetch });
    const r = await d.home('boson.ircforever.org', 'https://auth.boson.ircforever.org');
    expect(fetch).toHaveBeenCalledWith('https://boson.ircforever.org/.well-known/boson.json', expect.anything());
    expect(r.irc).toEqual({ host: 'irc.boson.ircforever.org', port: 6697, tls: true });
    expect(r.auth).toBe('https://auth.boson.ircforever.org');
    await d.home('boson.ircforever.org', 'https://auth.boson.ircforever.org');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('takes a dev / e2e document (BOSON_NETWORK_JSON) whose auth is the app\'s', async () => {
    const fetch = vi.fn();
    const d = new NetworkDiscoverer({
      fetch: fetch as unknown as typeof globalThis.fetch,
      overrides: [JSON.stringify({ version: 1, irc: { host: 'irc.selfhost.localhost', port: 6667, tls: false }, auth: { url: 'http://127.0.0.1:18080' } })],
    });
    const r = await d.home('selfhost.test', 'http://127.0.0.1:18080/');
    expect(r.irc).toEqual({ host: 'irc.selfhost.localhost', port: 6667, tls: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
