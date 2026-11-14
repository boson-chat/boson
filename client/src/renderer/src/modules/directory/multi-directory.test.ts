import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../shared/http/http.client';
import type { Server } from './directory.types';
import { mergeFacets, mergeListings, MultiDirectory, sortMerged } from './multi-directory';
import type { DirectorySource } from './sources';
import { fakeDirectory, fakeTransport, type FakeNetwork } from './test-directory-server';

const MAIN: DirectorySource = { url: 'https://directory.boson.chat', apiBase: 'https://directory.boson.chat', name: 'Boson', isDefault: true, enabled: true };
const PEER: DirectorySource = { url: 'https://dir.peer.example', apiBase: 'https://dir.peer.example', name: 'Peer', isDefault: false, enabled: true };

function row(id: string, host: string, extra: Partial<Server> = {}): Server {
  return {
    id, hostname: host, port: 6697, tls: true, name: id, tags: [], languages: [], is_nsfw: false, is_featured: false,
    verification_status: 'verified', health_status: 'up', registered_at: '2026-01-01T00:00:00Z', ...extra,
  };
}

function nets(prefix: string, n: number, extra: Partial<FakeNetwork> = {}): FakeNetwork[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, hostname: `irc${i}.${prefix}.example`, name: `${prefix} ${i}`, ...extra }));
}

describe('mergeListings', () => {
  const main = { url: MAIN.url, name: 'Boson', isDefault: true };
  const peer = { url: PEER.url, name: 'Peer', isDefault: false };

  it('keeps one row per hostname:port, preferring verified then the default', () => {
    const merged = mergeListings([
      [row('m1', 'irc.a.example', { source: main }), row('m2', 'irc.b.example', { source: main, verification_status: 'lapsed' })],
      [row('p1', 'IRC.A.example', { source: peer }), row('p2', 'irc.b.example', { source: peer }), row('p3', 'irc.b.example', { port: 6667, source: peer })],
    ]);
    expect(merged.map((s) => s.id)).toEqual(['m1', 'p2', 'p3']);
    expect(merged[0]!.also_listed_on).toEqual(['Peer']);
    expect(merged[1]!.also_listed_on).toEqual(['Boson']);
    expect(merged[2]!.also_listed_on).toBeUndefined();
  });

  it('interleaves sources and keeps ownership from any copy', () => {
    const merged = mergeListings([
      [row('m1', 'a', { source: main }), row('m2', 'b', { source: main })],
      [row('p1', 'c', { source: peer }), row('p2', 'a', { source: peer, owned: true })],
    ]);
    expect(merged.map((s) => s.id)).toEqual(['m1', 'p1', 'm2']);
    expect(merged[0]!.owned).toBe(true);
  });

  it('re-sorts merged rows', () => {
    const rows = [row('a', 'a', { user_count: 5, name: 'b' }), row('b', 'b', { user_count: 50, name: 'a' })];
    expect(sortMerged(rows, 'users').map((s) => s.id)).toEqual(['b', 'a']);
    expect(sortMerged(rows, 'name').map((s) => s.id)).toEqual(['b', 'a']);
    expect(sortMerged(rows, undefined).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('sums facets', () => {
    expect(mergeFacets([
      { tags: [{ value: 'dev', count: 2 }], languages: [{ value: 'en', count: 1 }] },
      { tags: [{ value: 'dev', count: 1 }, { value: 'art', count: 5 }], languages: [] },
    ])).toEqual({ tags: [{ value: 'art', count: 5 }, { value: 'dev', count: 3 }], languages: [{ value: 'en', count: 1 }] });
  });
});

describe('MultiDirectory', () => {
  it('pages through every directory with its own cursor', async () => {
    const main = fakeDirectory(MAIN.url, 'Boson', nets('m', 5));
    const peer = fakeDirectory(PEER.url, 'Peer', nets('p', 2));
    const md = new MultiDirectory({ sources: () => [MAIN, PEER], transport: fakeTransport([main, peer]), pageSize: 2 });
    let page = await md.search({ q: '' });
    expect(page.servers).toHaveLength(4);
    expect(page.hasMore).toBe(true);
    page = await md.loadMore();
    expect(page.servers).toHaveLength(6);
    expect(peer.requests).toHaveLength(1); // the peer was done after one page
    page = await md.loadMore();
    expect(page.servers).toHaveLength(7);
    expect(page.hasMore).toBe(false);
    expect(main.requests.map((r) => new URL(r.url).searchParams.get('cursor'))).toEqual([null, '2', '4']);
  });

  it('passes server-side filters to each directory', async () => {
    const main = fakeDirectory(MAIN.url, 'Boson', [
      { id: 'a', hostname: 'a', name: 'A', languages: ['en'], tags: ['dev'] },
      { id: 'b', hostname: 'b', name: 'B', languages: ['ja'], tags: ['dev'] },
      { id: 'c', hostname: 'c', name: 'C', languages: ['en'], tags: ['art'], is_nsfw: true },
    ]);
    const md = new MultiDirectory({ sources: () => [MAIN], transport: fakeTransport([main]) });
    expect((await md.search({ lang: 'en' })).servers.map((s) => s.id)).toEqual(['a']);
    expect((await md.search({ lang: 'en', nsfw: true, sort: 'users' })).servers.map((s) => s.id)).toEqual(['a', 'c']);
    expect(new URL(main.requests.at(-1)!.url).search).toContain('sort=users');
    expect((await md.search({ tag: 'dev' })).servers.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('skips disabled directories and reports one that fails', async () => {
    const main = fakeDirectory(MAIN.url, 'Boson', nets('m', 1));
    const peer = fakeDirectory(PEER.url, 'Peer', [], { down: 502 });
    const md = new MultiDirectory({ sources: () => [MAIN, PEER, { ...PEER, url: 'https://off.example', apiBase: 'https://off.example', enabled: false }], transport: fakeTransport([main, peer]) });
    const page = await md.search({});
    expect(page.servers).toHaveLength(1);
    expect(page.failures).toEqual([{ source: 'Peer', message: expect.any(String) }]);
    expect(page.legacy).toBe(false);
  });

  it('falls back to the legacy /servers list when no directory answers', async () => {
    const main = fakeDirectory(MAIN.url, 'Boson', [], { down: 0 });
    const legacy = vi.fn(async () => [row('srv_1', 'irc.old.example', { tags: ['dev'] }), row('srv_2', 'irc.other.example')]);
    const md = new MultiDirectory({ sources: () => [MAIN], transport: fakeTransport([main]), legacy });
    const page = await md.search({ q: 'x', tag: 'dev', sort: 'users' });
    expect(legacy).toHaveBeenCalledWith({ q: 'x', sort: 'users' });
    expect(page).toMatchObject({ legacy: true, hasMore: false });
    expect(page.servers.map((s) => s.id)).toEqual(['srv_1']);
    expect((await md.loadMore()).servers).toHaveLength(1);
  });

  it('does not fall back when the directory answers with a client error', async () => {
    const legacy = vi.fn(async () => [row('srv_1', 'h')]);
    const md = new MultiDirectory({
      sources: () => [MAIN],
      transport: async () => ({ status: 400, ok: false, statusText: 'Bad', text: '{"error":"bad cursor"}' }),
      legacy,
    });
    const page = await md.search({});
    expect(legacy).not.toHaveBeenCalled();
    expect(page.servers).toEqual([]);
    expect(page.failures[0]!.message).toBe('bad cursor');
  });

  it('surfaces the directory error when the legacy API is down too', async () => {
    const md = new MultiDirectory({
      sources: () => [MAIN],
      transport: async () => ({ status: 503, ok: false, statusText: '', text: '{"error":"maintenance"}' }),
      legacy: async () => { throw new HttpError(0, 'offline'); },
    });
    await expect(md.search({})).rejects.toThrow('maintenance');
  });

  it('drops a superseded search', async () => {
    const main = fakeDirectory(MAIN.url, 'Boson', nets('m', 3));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = fakeTransport([main]);
    const md = new MultiDirectory({
      sources: () => [MAIN],
      transport: async (req) => { if (req.url.includes('q=old')) await gate; return base(req); },
    });
    const a = md.search({ q: 'old' });
    const b = await md.search({ q: 'm 1' });
    release();
    await a;
    expect(b.servers.map((s) => s.id)).toEqual(['m1']);
    expect(md.current().servers.map((s) => s.id)).toEqual(['m1']);
  });

  it('marks owned rows', async () => {
    const main = fakeDirectory(MAIN.url, 'Boson', nets('m', 2));
    const owned = new Map([[MAIN.url, new Set(['m1'])]]);
    const md = new MultiDirectory({ sources: () => [MAIN], transport: fakeTransport([main]), owned: () => owned });
    const page = await md.search({});
    expect(page.servers.find((s) => s.id === 'm1')!.owned).toBe(true);
    expect(page.servers.find((s) => s.id === 'm0')!.owned).toBeUndefined();
  });

  it('merges facets across directories', async () => {
    const main = fakeDirectory(MAIN.url, 'Boson', [{ id: 'a', hostname: 'a', name: 'A', tags: ['dev'], languages: ['en'] }]);
    const peer = fakeDirectory(PEER.url, 'Peer', [{ id: 'b', hostname: 'b', name: 'B', tags: ['dev'], languages: ['ja'] }]);
    const md = new MultiDirectory({ sources: () => [MAIN, PEER], transport: fakeTransport([main, peer]) });
    const f = await md.facets();
    expect(f.tags).toEqual([{ value: 'dev', count: 2 }]);
    expect(f.languages.map((l) => l.value).sort()).toEqual(['en', 'ja']);
  });
});
