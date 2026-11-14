import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../shared/http/http.client';
import type { HostingApi } from './network-api';
import { FallbackHostingApi, NetworkDirectories } from './networks';
import { DirectorySources } from './sources';
import { fakeDirectory, fakeTransport } from './test-directory-server';

function legacy(): HostingApi {
  return {
    listMyServers: vi.fn(async () => []),
    registerServer: vi.fn(),
    verifyServer: vi.fn(),
    regenerateServerToken: vi.fn(),
    updateServerProfile: vi.fn(),
    uploadServerImage: vi.fn(),
    deleteServerImage: vi.fn(),
  } as unknown as HostingApi;
}

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('FallbackHostingApi', () => {
  it('switches to the legacy API when the directory does not answer', async () => {
    const primary = { ...legacy(), listMyServers: vi.fn(async () => { throw new HttpError(0, 'connection refused'); }), deleteServer: vi.fn() } as HostingApi;
    const old = legacy();
    const api = new FallbackHostingApi(primary, old);
    expect(api.supportsDelete()).toBe(true);
    await api.listMyServers();
    expect(old.listMyServers).toHaveBeenCalled();
    expect(api.usingLegacy).toBe(true);
    expect(api.supportsDelete()).toBe(false);
  });

  it('sticks with the directory once it has answered', async () => {
    const primary = { ...legacy(), registerServer: vi.fn(async () => { throw new HttpError(503, 'down'); }) } as HostingApi;
    const old = legacy();
    const api = new FallbackHostingApi(primary, old);
    await api.listMyServers();
    await expect(api.registerServer({ hostname: 'h', port: 1, tls: true, name: 'n' })).rejects.toThrow('down');
    expect(old.registerServer).not.toHaveBeenCalled();
  });

  it('does not fall back on a client error', async () => {
    const primary = { ...legacy(), listMyServers: vi.fn(async () => { throw new HttpError(403, 'no'); }) } as HostingApi;
    const old = legacy();
    await expect(new FallbackHostingApi(primary, old).listMyServers()).rejects.toThrow('no');
    expect(old.listMyServers).not.toHaveBeenCalled();
  });
});

describe('NetworkDirectories', () => {
  it('builds owner APIs only for directories that accept our accounts', async () => {
    const ours = fakeDirectory('https://dir.ours.example', 'Ours', [], { authIssuer: 'https://auth.boson.chat' });
    const theirs = fakeDirectory('https://dir.theirs.example', 'Theirs', []);
    const transport = fakeTransport([ours, theirs]);
    const sources = new DirectorySources({ storage: memStorage(), transport, authUrl: 'https://auth.boson.chat' });
    await sources.add('dir.ours.example');
    await sources.add('dir.theirs.example');
    const n = new NetworkDirectories(sources, { getToken: async () => 'jwt' }, transport);
    expect(n.ownerApi('https://dir.theirs.example')).toBeNull();
    expect(n.ownerApi('https://dir.ours.example')).not.toBeNull();
    expect(n.hostable().map((s) => s.name)).toEqual(['Boson directory', 'Ours']);
    expect(n.hostingApi('https://directory.boson.chat', legacy())).toBeInstanceOf(FallbackHostingApi);
    expect(n.hostingApi('https://dir.ours.example', legacy())).not.toBeInstanceOf(FallbackHostingApi);
  });
});
