import { describe, expect, it, vi } from 'vitest';
import { NetworkDiscoverer, cleanBaseUrl, discoveryDomain, parseBosonJson } from './discovery';
import { normalizeServerAddress, webNetAuthBridge } from './netauth';

const doc = (o: Record<string, unknown>) => JSON.stringify({ version: 1, ...o });

describe('boson.json discovery', () => {
  it('derives the domain like the desktop', () => {
    expect(discoveryDomain('irc.example.com')).toBe('example.com');
    expect(discoveryDomain('example.com')).toBe('example.com');
    expect(discoveryDomain('a.b.example.com')).toBe('b.example.com');
    expect(discoveryDomain('localhost')).toBe('');
    expect(discoveryDomain('irc.localhost')).toBe('localhost');
    expect(discoveryDomain('auth.localhost')).toBe('localhost');
    expect(discoveryDomain('127.0.0.1')).toBe('');
    expect(discoveryDomain('[::1]')).toBe('');
  });

  it('accepts https base URLs, loopback http only when allowed', () => {
    expect(cleanBaseUrl('https://Auth.Example.com/', false)).toBe('https://auth.example.com');
    expect(cleanBaseUrl('http://auth.example.com', false)).toBeNull();
    expect(cleanBaseUrl('http://127.0.0.1:18180', false)).toBeNull();
    expect(cleanBaseUrl('http://127.0.0.1:18180', true)).toBe('http://127.0.0.1:18180');
    expect(cleanBaseUrl('http://evil.example.com', true)).toBeNull();
    expect(cleanBaseUrl('https://u:p@x.example.com', false)).toBeNull();
    expect(cleanBaseUrl('https://x.example.com/?q=1', false)).toBeNull();
  });

  it('parses a version-1 document and validates voice', () => {
    const d = parseBosonJson(doc({
      irc: { host: 'IRC.example.com', port: 6697, tls: true },
      auth: { url: 'https://auth.example.com' },
      voice: { addr: 'voice.example.com:7700', url: 'https://voice.example.com' },
      directory: { url: 'https://dir.example.com' },
      files: { url: 'https://files.example.com' },
      branding: 'https://auth.example.com/v1/branding',
    }), false)!;
    expect(d.irc).toEqual({ host: 'irc.example.com', port: 6697, tls: true });
    expect(d.voice).toEqual({ addr: 'voice.example.com:7700', url: 'https://voice.example.com', authUrl: 'https://auth.example.com', source: 'well-known' });
    expect(d.files).toBe('https://files.example.com');
    expect(d.branding).toBe('https://auth.example.com/v1/branding');
    expect(parseBosonJson(doc({ voice: { addr: 'v:7700', url: 'https://v' } }), false)!.voiceError).toMatch(/without auth/);
    expect(parseBosonJson(JSON.stringify({ version: 2 }), false)).toBeNull();
    expect(parseBosonJson('nope', false)).toBeNull();
  });

  it('fetches from the domain, caches, and keeps an older answer on a network error', async () => {
    let fail = false;
    const f = vi.fn(async (url: string) => {
      if (fail) throw new TypeError('offline');
      expect(url).toBe('https://example.com/.well-known/boson.json');
      return new Response(doc({ auth: { url: 'https://auth.example.com' } }));
    });
    let now = 0;
    const d = new NetworkDiscoverer({ fetch: f as unknown as typeof fetch, now: () => now });
    expect((await d.discover('irc.example.com')).auth).toBe('https://auth.example.com');
    await d.discover('irc.example.com');
    expect(f).toHaveBeenCalledTimes(1);
    fail = true;
    now = 60 * 60_000;
    expect((await d.discover('irc.example.com')).auth).toBe('https://auth.example.com');
    expect((await d.discover('localhost')).answered).toBe(false);
  });

  it('takes BOSON_NETWORK_JSON documents for hosts without a domain', async () => {
    const d = new NetworkDiscoverer({
      fetch: (() => { throw new Error('no fetch'); }) as unknown as typeof fetch,
      overrides: [doc({ irc: { host: 'localhost', port: 16668 }, auth: { url: 'http://127.0.0.1:18181' } }), doc({ irc: { host: 'x' } })],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await d.discover('LOCALHOST');
    expect(r.override).toBe(true);
    expect(r.auth).toBe('http://127.0.0.1:18181');
  });
});

describe('web netauth', () => {
  it('normalizes what the user typed', () => {
    expect(normalizeServerAddress('Example.com')).toBe('example.com');
    expect(normalizeServerAddress('ircs://irc.example.com:6697')).toBe('irc.example.com');
    expect(normalizeServerAddress('irc.example.com:6697/x')).toBe('irc.example.com');
    expect(normalizeServerAddress('ftp://x.com')).toBeNull();
    expect(normalizeServerAddress('bad_host!')).toBeNull();
  });

  it('marks the main auth service and refuses the app API as a sign-in service', async () => {
    const docs: Record<string, string> = {
      'https://main.example/.well-known/boson.json': doc({ auth: { url: 'https://auth.boson.test' } }),
      'https://evil.example/.well-known/boson.json': doc({ auth: { url: 'https://api.boson.test' } }),
      'https://net.example/.well-known/boson.json': doc({ irc: { host: 'irc.net.example', port: 6697, tls: true }, auth: { url: 'https://auth.net.example' } }),
    };
    const f = async (url: string) => (docs[url] ? new Response(docs[url]) : new Response('', { status: 404 }));
    const discoverer = new NetworkDiscoverer({ fetch: f as unknown as typeof fetch });
    const b = webNetAuthBridge({ discoverer, mainAuthUrl: 'https://auth.boson.test', appOrigins: ['https://api.boson.test'] });
    expect(await b.discover('irc.main.example', false)).toMatchObject({ authUrl: 'https://auth.boson.test', main: true });
    expect(await b.discover('irc.evil.example', false)).toMatchObject({ main: false, error: 'not a sign-in service' });
    expect(await b.resolve('net.example')).toMatchObject({ domain: 'net.example', irc: { host: 'irc.net.example' }, authUrl: 'https://auth.net.example', main: false });
    expect(await b.resolve('nothing.example')).toMatchObject({ error: 'no-boson-json' });
    expect(await b.resolve('!!')).toMatchObject({ error: 'invalid' });
  });
});
