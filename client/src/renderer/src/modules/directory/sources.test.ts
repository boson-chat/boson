import { describe, expect, it } from 'vitest';
import {
  DirectoryCheckError,
  DirectorySources,
  normalizeDirectoryUrl,
  shellEntries,
} from './sources';
import { fakeDirectory, fakeTransport } from './test-directory-server';

function memStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe('normalizeDirectoryUrl', () => {
  it('accepts a bare host or an https origin', () => {
    expect(normalizeDirectoryUrl('directory.example.org')).toEqual({ url: 'https://directory.example.org' });
    expect(normalizeDirectoryUrl(' https://Dir.Example.org/ ')).toEqual({ url: 'https://dir.example.org' });
    expect(normalizeDirectoryUrl('https://dir.example.org:8443')).toEqual({ url: 'https://dir.example.org:8443' });
  });

  it.each([
    ['', 'Enter'],
    ['http://dir.example.org', 'https'],
    ['ftp://dir.example.org', 'https'],
    ['https://u:p@dir.example.org', 'username'],
    ['https://dir.example.org/v1', 'path'],
    ['https://dir.example.org/?x=1', 'path'],
    ['https://dir.example.org/#a', 'path'],
    ['http://localhost:4100', 'https'],
  ])('rejects %s', (input, why) => {
    const res = normalizeDirectoryUrl(input);
    expect('error' in res && res.error).toMatch(new RegExp(why, 'i'));
  });

  it('allows http to loopback only in dev', () => {
    expect(normalizeDirectoryUrl('http://localhost:4100', { allowLoopbackHttp: true })).toEqual({ url: 'http://localhost:4100' });
    expect('error' in normalizeDirectoryUrl('http://10.0.0.2', { allowLoopbackHttp: true })).toBe(true);
  });
});

describe('DirectorySources', () => {
  const friends = fakeDirectory('https://dir.friends.example', 'Friends Net', [], { operator: 'Friends e.V.' });
  const transport = fakeTransport([friends]);

  it('starts with the default directory, enabled', () => {
    const s = new DirectorySources({ storage: memStorage() });
    expect(s.list()).toEqual([expect.objectContaining({ url: 'https://directory.boson.chat', isDefault: true, enabled: true })]);
  });

  it('uses the configured default', () => {
    const s = new DirectorySources({ defaultUrl: 'http://localhost:4100/', storage: memStorage() });
    expect(s.defaultSourceUrl).toBe('http://localhost:4100');
  });

  it('adds a directory after checking its well-known, and persists it', async () => {
    const storage = memStorage();
    const s = new DirectorySources({ storage, transport });
    const changes: number[] = [];
    s.subscribe((l) => changes.push(l.length));
    const src = await s.add('dir.friends.example');
    expect(src).toMatchObject({ url: 'https://dir.friends.example', name: 'Friends Net', operator: 'Friends e.V.', enabled: true, isDefault: false });
    expect(changes).toEqual([2]);
    const again = new DirectorySources({ storage, transport });
    expect(again.list().map((d) => d.name)).toEqual(['Boson directory', 'Friends Net']);
  });

  it('refuses a non-directory, a duplicate and an unreachable host', async () => {
    const s = new DirectorySources({ storage: memStorage(), transport });
    await expect(s.add('nowhere.example')).rejects.toThrow(DirectoryCheckError);
    await expect(s.add('directory.boson.chat')).rejects.toThrow(/already/);
    await s.add('dir.friends.example');
    await expect(s.add('https://dir.friends.example/')).rejects.toThrow(/already/);
    const notDir = fakeTransport([fakeDirectory('https://web.example', 'x', [], { down: 404 })]);
    await expect(new DirectorySources({ storage: memStorage(), transport: notDir }).add('web.example')).rejects.toThrow(/isn’t a boson directory/);
  });

  it('removes others but only disables the default', async () => {
    const s = new DirectorySources({ storage: memStorage(), transport });
    await s.add('dir.friends.example');
    s.remove('https://directory.boson.chat');
    s.setEnabled('https://directory.boson.chat', false);
    expect(s.list()[0]).toMatchObject({ isDefault: true, enabled: false });
    expect(s.enabled().map((d) => d.name)).toEqual(['Friends Net']);
    s.remove('https://dir.friends.example');
    expect(s.list()).toHaveLength(1);
  });

  it('owner calls go only to directories that accept our accounts', async () => {
    const ours = fakeDirectory('https://dir.ours.example', 'Ours', [], { authIssuer: 'https://auth.boson.chat' });
    const theirs = fakeDirectory('https://dir.theirs.example', 'Theirs', [], { authIssuer: 'https://auth.theirs.example' });
    const s = new DirectorySources({ storage: memStorage(), transport: fakeTransport([ours, theirs]), authUrl: 'https://auth.boson.chat' });
    await s.add('dir.ours.example');
    await s.add('dir.theirs.example');
    expect(s.hostable().map((d) => d.name)).toEqual(['Boson directory', 'Ours']);
    expect(shellEntries(s)).toEqual([
      { url: 'https://directory.boson.chat', owner: true },
      { url: 'https://dir.ours.example', owner: true },
      { url: 'https://dir.theirs.example' },
    ]);
  });

  it('refreshes the default directory’s name from its well-known', async () => {
    const main = fakeDirectory('https://directory.boson.chat', 'Boson Network Directory', [], { operator: 'boson' });
    const s = new DirectorySources({ storage: memStorage(), transport: fakeTransport([main]) });
    await s.refreshDefault();
    expect(s.list()[0]).toMatchObject({ name: 'Boson Network Directory', operator: 'boson', isDefault: true });
  });
});
