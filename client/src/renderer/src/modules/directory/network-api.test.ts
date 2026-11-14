import { describe, expect, it } from 'vitest';
import { HttpError } from '../../shared/http/http.client';
import type { ApiRequest } from '../../shared/http/transport';
import { listQuery, NetworkDirectoryApi, NetworkOwnerApi, networkToServer, parseFacets } from './network-api';
import type { DirectorySource } from './sources';
import { fakeDirectory, fakeTransport } from './test-directory-server';

const SRC: DirectorySource = { url: 'https://dir.example', apiBase: 'https://dir.example', name: 'Example', isDefault: true, enabled: true };

describe('network-api', () => {
  it('maps a /v1 network onto a Server', () => {
    const s = networkToServer({
      id: 'net_1', hostname: 'IRC.Example.org', port: 6697, tls: true, name: 'Ex', tags: ['a'], languages: ['en'],
      is_nsfw: false, status: 'verified', health_status: 'up', user_count: 12, created_at: '2026-01-01T00:00:00Z',
      icon_url: 'https://cdn/i.png', token_issued_at: '2026-01-02T00:00:00Z', verification_token: 't',
    }, { url: SRC.url, name: SRC.name, isDefault: true });
    expect(s).toMatchObject({
      id: 'net_1', hostname: 'irc.example.org', verification_status: 'verified', health_status: 'up', user_count: 12,
      registered_at: '2026-01-01T00:00:00Z', icon_url: 'https://cdn/i.png', verification_token: 't',
      verification_token_issued_at: '2026-01-02T00:00:00Z', source: { name: 'Example', isDefault: true },
    });
    expect(networkToServer({ id: 'x', hostname: 'h', status: 'weird' }).verification_status).toBe('pending');
  });

  it('maps banner_url and legacy_id', () => {
    const s = networkToServer({ id: 'net_1', hostname: 'h', banner_url: 'https://d/b.png', legacy_id: '398464ce-c861-4244-a16c-b26c046a1bd4' });
    expect(s.banner_url).toBe('https://d/b.png');
    expect(s.legacy_id).toBe('398464ce-c861-4244-a16c-b26c046a1bd4');
    expect('legacy_id' in networkToServer({ id: 'net_2', hostname: 'h' })).toBe(false);
  });

  it('looks a network up by hostname; null when the directory does not list it', async () => {
    const dir = fakeDirectory(SRC.url, 'Example', [{ id: 'net_1', hostname: 'irc.example.org', name: 'Ex', icon_url: 'https://d/i.png' }]);
    const api = new NetworkDirectoryApi(SRC, fakeTransport([dir]));
    const row = await api.lookupNetwork('irc.example.org');
    expect(row).toMatchObject({ id: 'net_1', icon_url: 'https://d/i.png', source: { url: SRC.url } });
    expect(dir.requests.at(-1)!.url).toBe('https://dir.example/v1/networks/lookup?hostname=irc.example.org');
    expect(await api.lookupNetwork('irc.nowhere.example')).toBeNull();
    dir.down = 500;
    await expect(api.lookupNetwork('irc.example.org')).rejects.toBeInstanceOf(HttpError);
  });

  it('builds the list query', () => {
    expect(listQuery({})).toBe('');
    expect(listQuery({ q: 'foss', lang: 'en', tag: 'dev', nsfw: true, sort: 'users', limit: 25, cursor: 'abc' }))
      .toBe('?q=foss&lang=en&tag=dev&nsfw=true&sort=users&limit=25&cursor=abc');
  });

  it('parses facets in either shape', () => {
    expect(parseFacets({ tags: [{ tag: 'dev', count: 3 }], languages: [{ language: 'en', count: 5 }] }))
      .toEqual({ tags: [{ value: 'dev', count: 3 }], languages: [{ value: 'en', count: 5 }] });
    expect(parseFacets({ tags: { dev: 2 }, languages: ['ja'] }))
      .toEqual({ tags: [{ value: 'dev', count: 2 }], languages: [{ value: 'ja', count: 0 }] });
  });

  it('public reads never carry a token', async () => {
    const reqs: ApiRequest[] = [];
    const api = new NetworkDirectoryApi(SRC, async (r) => {
      reqs.push(r);
      return { status: 200, ok: true, statusText: 'OK', text: JSON.stringify({ networks: [{ id: 'n', hostname: 'h', name: 'H' }], next_cursor: 'c2', total_estimate: 40 }) };
    });
    const page = await api.listNetworks({ q: 'x', cursor: 'c1' });
    expect(page.nextCursor).toBe('c2');
    expect(page.totalEstimate).toBe(40);
    expect(reqs[0]!.url).toBe('https://dir.example/v1/networks?q=x&cursor=c1');
    expect(reqs[0]!.headers['Authorization']).toBeUndefined();
  });

  it('runs the owner flow against /v1', async () => {
    const dir = fakeDirectory('https://dir.example', 'Example', []);
    const api = new NetworkOwnerApi(SRC, { getToken: async () => 'jwt' }, fakeTransport([dir], { user: 'u1' }));
    const created = await api.registerServer({ hostname: 'irc.mine.example', port: 6697, tls: true, name: 'Mine', languages: ['en'] });
    expect(created).toMatchObject({ id: 'net_1', verification_status: 'pending', verification_token: 'tok123', owned: true });
    expect(await api.listMyServers()).toEqual([expect.objectContaining({ id: 'net_1', owned: true })]);
    const v = await api.verifyServer('net_1');
    expect(v.success).toBe(true);
    expect(v.server.verification_status).toBe('verified');
    expect(v.report.results['cloudflare']?.outcome).toBe('match');
    const patched = await api.updateServerProfile('net_1', { description: 'hello' });
    expect(patched.description).toBe('hello');
    const withIcon = await api.uploadServerImage('net_1', 'icon', new Blob(['x'], { type: 'image/png' }));
    expect(withIcon.icon_url).toContain('/media/net_1.png');
    expect(dir.requests.at(-1)!.method).toBe('PUT');
    await api.deleteServer('net_1');
    expect(await api.listMyServers()).toEqual([]);
  });

  it('returns the 409 verify report, and throws on 410', async () => {
    const report = { success: false, results: { google: { outcome: 'missing_record' } } };
    let status = 409;
    const api = new NetworkOwnerApi(SRC, { getToken: async () => 'jwt' }, async () => ({
      status, ok: false, statusText: '', text: JSON.stringify(status === 409 ? { network: { id: 'n', hostname: 'h', status: 'pending' }, report, success: false } : { error: 'token expired' }),
    }));
    const res = await api.verifyServer('n');
    expect(res).toMatchObject({ success: false, report, server: { id: 'n' } });
    status = 410;
    await expect(api.verifyServer('n')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('networkToServer theme', () => {
  it('keeps an object theme and drops null', () => {
    const base = { id: 'net_1', hostname: 'irc.ex.org', port: 6697, name: 'Ex' };
    expect(networkToServer({ ...base, theme: { version: 1, colors: { accent: '#000000' } } }).theme).toEqual({ version: 1, colors: { accent: '#000000' } });
    expect('theme' in networkToServer({ ...base, theme: null })).toBe(false);
  });
});
