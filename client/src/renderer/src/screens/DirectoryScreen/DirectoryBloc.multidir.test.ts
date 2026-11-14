import { describe, expect, it, vi } from 'vitest';
import { DirectoryBloc } from './DirectoryBloc';
import type { AuthService } from '../../modules/auth';
import type { DirectoryService, User } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { SessionStore } from '../../modules/session';
import { NetworkDirectories } from '../../modules/directory/networks';
import { DirectorySources } from '../../modules/directory/sources';
import { fakeDirectory, fakeTransport, type FakeNetwork } from '../../modules/directory/test-directory-server';

// The directory screen on the /v1 network directories: paging, server-side
// filters, the source list, ownership and owner calls routed per directory.

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(), key: () => null, get length() { return m.size; },
  };
}

const user: User = { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' };

function legacyApi(): DirectoryService {
  return {
    getMe: vi.fn(async () => user),
    getSavedSession: vi.fn(async () => null),
    putSavedSession: vi.fn(async () => undefined),
    listServers: vi.fn(async () => []),
    updateServerProfile: vi.fn(),
  } as unknown as DirectoryService;
}

function nets(prefix: string, n: number, extra: Partial<FakeNetwork> = {}): FakeNetwork[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, hostname: `irc${i}.${prefix}.example`, name: `${prefix}${i}`, languages: ['en'], ...extra }));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function setup(mainNets: FakeNetwork[], peerNets?: FakeNetwork[]) {
  const main = fakeDirectory('https://directory.boson.chat', 'Boson', mainNets);
  const peer = fakeDirectory('https://dir.peer.example', 'Peer', peerNets ?? [], { authIssuer: 'https://auth.boson.chat' });
  const transport = fakeTransport([main, peer], { user: 'u1' });
  const sources = new DirectorySources({ storage: memStorage(), transport, authUrl: 'https://auth.boson.chat' });
  const directory = legacyApi();
  const networks = new NetworkDirectories(sources, { getToken: async () => 'jwt' }, transport, (p) => directory.listServers(p));
  const bloc = new DirectoryBloc({
    auth: { getState: () => ({ session: null, loading: false, error: null }), subscribe: () => () => {} } as unknown as AuthService,
    directory,
    networks,
    identity: { isUnlocked: () => true, subscribe: () => () => {} } as unknown as IdentityService,
    engine: null,
    sessionStore: new SessionStore(memStorage()),
  });
  return { bloc, main, peer, sources, directory };
}

describe('DirectoryBloc with network directories', () => {
  it('loads the first page, then more on loadMore', async () => {
    const { bloc, main } = setup(nets('m', 30));
    await settle();
    let s = bloc.getState();
    expect(s.servers).toHaveLength(25);
    expect(s.hasMore).toBe(true);
    expect(s.serverFilters).toBe(true);
    expect(s.facets?.languages).toEqual([{ value: 'en', count: 30 }]);
    await bloc.loadMore();
    s = bloc.getState();
    expect(s.servers).toHaveLength(30);
    expect(s.hasMore).toBe(false);
    expect(s.loadingMore).toBe(false);
    expect(main.requests.filter((r) => r.url.includes('/v1/networks?')).length).toBe(2);
    bloc.dispose();
  });

  it('language, tag and sort refetch from the directory', async () => {
    const { bloc, main } = setup([
      { id: 'a', hostname: 'a.example', name: 'A', languages: ['en'], tags: ['dev'] },
      { id: 'b', hostname: 'b.example', name: 'B', languages: ['ja'], tags: ['art'] },
    ]);
    await settle();
    bloc.setLanguage('ja');
    await settle();
    expect(bloc.getState().filteredServers?.map((s) => s.id)).toEqual(['b']);
    expect(main.requests.at(-1)!.url).toContain('lang=ja');
    bloc.setLanguage('all');
    bloc.setTag('dev');
    await settle();
    expect(bloc.getState().filteredServers?.map((s) => s.id)).toEqual(['a']);
    bloc.setSort('newest');
    await settle();
    expect(main.requests.at(-1)!.url).toMatch(/tag=dev.*sort=newest/);
    bloc.dispose();
  });

  it('merges an added directory and marks its rows', async () => {
    const { bloc, sources } = setup(nets('m', 1), [
      { id: 'p0', hostname: 'irc0.m.example', name: 'dup' },
      { id: 'p1', hostname: 'irc.peer-only.example', name: 'Peer only' },
    ]);
    await settle();
    expect(bloc.getState().multiDirectory).toBe(false);
    await sources.add('dir.peer.example');
    await settle();
    const s = bloc.getState();
    expect(s.multiDirectory).toBe(true);
    expect(s.servers?.map((x) => [x.id, x.source?.name])).toEqual([['m0', 'Boson directory'], ['p1', 'Peer']]);
    expect(s.servers?.[0]?.also_listed_on).toEqual(['Peer']);
    bloc.dispose();
  });

  it('marks owned listings and routes owner edits to their directory', async () => {
    const { bloc, main, directory } = setup([{ id: 'mine', hostname: 'irc.mine.example', name: 'Mine', owner: 'u1' }, ...nets('m', 2)]);
    await settle();
    const mine = bloc.getState().servers?.find((s) => s.id === 'mine');
    expect(mine?.owned).toBe(true);
    await bloc.updateServerProfile('mine', { description: 'new words' });
    expect(directory.updateServerProfile).not.toHaveBeenCalled();
    const patch = main.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.url).toBe('https://directory.boson.chat/v1/networks/mine');
    expect(patch.headers['Authorization']).toBe('Bearer jwt');
    expect(bloc.getState().servers?.find((s) => s.id === 'mine')?.description).toBe('new words');
    bloc.dispose();
  });

  it('falls back to the legacy list when the directory is down', async () => {
    const { bloc, main, directory } = setup([]);
    main.down = 0;
    (directory.listServers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'srv_1', hostname: 'irc.old.example', port: 6697, tls: true, name: 'Old', tags: [], languages: ['en'], is_nsfw: false, is_featured: false, verification_status: 'verified', health_status: 'up', registered_at: '2026-01-01' },
    ]);
    bloc.refreshDirectory();
    await settle();
    const s = bloc.getState();
    expect(s.legacyDirectory).toBe(true);
    expect(s.serverFilters).toBe(false);
    expect(s.servers?.map((x) => x.id)).toEqual(['srv_1']);
    bloc.dispose();
  });
});
