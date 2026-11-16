import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemorySeenBackend, SeenStore, foldNick, mergeSeen, seenMask, type SeenRecord } from './seen.store';
import { clearAllSeen, seenNamespace, seenStoreFor, wipeSeenForUser, __resetSeenRegistry } from './seen.idb';
import { __resetPrivacySettingsCache, setPrivacySettings } from '../ui/privacy.store';

// The per-server "seen" record: nick → last user@host, account, realname,
// when/where, kept after they leave. Local only.

const on = () => true;

describe('SeenStore', () => {
  it('records a sighting and folds the nick case', () => {
    const s = new SeenStore('ns', null, { enabled: on });
    s.note('Witty[Quail]', { user: '~WittyQuail', host: '101.128.125.37', account: 'wq', realname: 'Witty', channel: '#lobby', at: 1000 });
    expect(foldNick('Witty[Quail]')).toBe('witty{quail}');
    expect(s.get('witty{QUAIL}')).toEqual({
      nick: 'Witty[Quail]', user: '~WittyQuail', host: '101.128.125.37', account: 'wq', realname: 'Witty',
      lastSeenAt: 1000, channels: ['#lobby'],
    });
    expect(seenMask(s.get('witty[quail]')!)).toBe('~WittyQuail@101.128.125.37');
  });

  it('a newer sighting updates; the old host goes to prevHosts (≤5); account null logs out', () => {
    const s = new SeenStore('ns', null, { enabled: on });
    s.note('bob', { user: 'b', host: 'h0', account: 'bob', at: 1 });
    for (let i = 1; i <= 7; i++) s.note('bob', { user: 'b', host: `h${i}`, at: 1 + i });
    const r = s.get('bob')!;
    expect(r.host).toBe('h7');
    expect(r.prevHosts).toEqual(['b@h6', 'b@h5', 'b@h4', 'b@h3', 'b@h2']);
    s.note('bob', { account: null, at: 100 });
    expect(s.get('bob')!.account).toBeUndefined();
    expect(s.get('bob')!.host).toBe('h7'); // absent ≠ cleared
  });

  it('an older sighting (replayed history) only fills gaps', () => {
    const s = new SeenStore('ns', null, { enabled: on });
    s.note('bob', { host: 'new.host', channel: '#a', at: 5000 });
    s.note('bob', { user: 'old', host: 'old.host', realname: 'Bob', channel: '#b', at: 10 });
    expect(s.get('bob')).toMatchObject({ host: 'new.host', realname: 'Bob', lastSeenAt: 5000, channels: ['#a', '#b'] });
  });

  it('keeps channels most recent first, without repeats', () => {
    const s = new SeenStore('ns', null, { enabled: on });
    s.note('bob', { channel: '#a', at: 1 });
    s.note('bob', { channel: '#b', at: 2 });
    s.note('bob', { channel: '#a', at: 3 });
    expect(s.get('bob')!.channels).toEqual(['#a', '#b']);
  });

  it('a WHOIS stamps lastWhoisAt', () => {
    const s = new SeenStore('ns', null, { enabled: on });
    s.note('bob', { host: 'h', whois: true, actualHost: '203.0.113.9', at: 42 });
    expect(s.get('bob')).toMatchObject({ lastWhoisAt: 42, actualHost: '203.0.113.9' });
  });

  it('a nick change carries the identity to the new nick and keeps the old one', () => {
    const s = new SeenStore('ns', null, { enabled: on });
    s.note('alice', { user: 'a', host: 'alice.host', account: 'al', channel: '#x', at: 1 });
    s.rename('alice', 'alice_away', 50);
    expect(s.get('alice_away')).toMatchObject({ nick: 'alice_away', host: 'alice.host', account: 'al', channels: ['#x'], lastSeenAt: 50 });
    expect(s.get('alice')).toMatchObject({ host: 'alice.host', lastSeenAt: 50 });
  });

  it('caps the store, evicting the least recently seen', () => {
    const s = new SeenStore('ns', null, { enabled: on, cap: 3 });
    s.note('a', { host: 'h', at: 10 });
    s.note('b', { host: 'h', at: 5 });
    s.note('c', { host: 'h', at: 20 });
    s.note('a', { at: 30 }); // a is now the most recent
    s.note('d', { host: 'h', at: 40 });
    expect(s.size).toBe(3);
    expect(s.get('b')).toBeUndefined();
    expect(['a', 'c', 'd'].every((n) => s.get(n))).toBe(true);
  });

  it('a big store trims a little under the cap at once (2%)', () => {
    const s = new SeenStore('ns', null, { enabled: on, cap: 100 });
    for (let i = 0; i < 101; i++) s.note(`n${i}`, { host: 'h', at: i });
    expect(s.size).toBe(98);
    expect(s.get('n0')).toBeUndefined();
    expect(s.get('n100')).toBeDefined();
  });

  it('records and shows nothing while disabled', () => {
    let enabled = true;
    const s = new SeenStore('ns', null, { enabled: () => enabled });
    s.note('bob', { host: 'h', at: 1 });
    enabled = false;
    expect(s.get('bob')).toBeUndefined();
    expect(s.all()).toEqual([]);
    s.note('carol', { host: 'h', at: 2 });
    enabled = true;
    expect(s.get('carol')).toBeUndefined();
    expect(s.get('bob')).toBeDefined(); // kept, just hidden while off
  });

  it('follows the privacy setting by default', () => {
    __resetPrivacySettingsCache();
    const s = new SeenStore('ns');
    s.note('bob', { host: 'h' });
    expect(s.get('bob')).toBeDefined();
    setPrivacySettings({ rememberHosts: false });
    expect(s.get('bob')).toBeUndefined();
    expect(s.recording).toBe(false);
    setPrivacySettings({ rememberHosts: true });
    localStorage.clear();
    __resetPrivacySettingsCache();
  });

  it('bumps version only when what a profile shows changes', () => {
    const s = new SeenStore('ns', null, { enabled: on });
    s.note('bob', { host: 'h', channel: '#a', at: 1 });
    const v = s.version.peek();
    s.note('bob', { host: 'h', channel: '#a', at: 2 }); // just a newer time
    expect(s.version.peek()).toBe(v);
    s.note('bob', { host: 'h2', at: 3 });
    expect(s.version.peek()).toBe(v + 1);
  });
});

describe('SeenStore persistence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('round-trips through the backend, per namespace', async () => {
    const backend = new MemorySeenBackend();
    const a = new SeenStore('u1::srv', backend, { enabled: on });
    const other = new SeenStore('u1::other', backend, { enabled: on });
    a.note('bob', { user: '~b', host: 'b.host', account: 'bob', realname: 'Bob', channel: '#lobby', at: 100 });
    other.note('eve', { host: 'e', at: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    const b = new SeenStore('u1::srv', backend, { enabled: on });
    await b.ready;
    expect(b.get('BOB')).toEqual(a.get('bob'));
    expect(b.get('eve')).toBeUndefined();
  });

  it('merges what was noted before the load landed', async () => {
    const backend = new MemorySeenBackend();
    await backend.save('ns', [{ nick: 'bob', host: 'old', realname: 'Bob', lastSeenAt: 10, channels: ['#a'] }], []);
    const s = new SeenStore('ns', backend, { enabled: on });
    s.note('bob', { host: 'new', at: 20, channel: '#b' });
    await s.ready;
    expect(s.get('bob')).toMatchObject({ host: 'new', realname: 'Bob', channels: ['#b', '#a'], prevHosts: ['old'] });
  });

  it('writes evictions as deletes', async () => {
    const backend = new MemorySeenBackend();
    const s = new SeenStore('ns', backend, { enabled: on, cap: 1 });
    s.note('a', { host: 'h', at: 1 });
    await s.flush();
    s.note('b', { host: 'h', at: 2 });
    await s.flush();
    expect([...backend.rows.keys()]).toEqual(['ns\u0001b']);
  });

  it('clear() empties memory and the namespace on disk', async () => {
    const backend = new MemorySeenBackend();
    const s = new SeenStore('ns', backend, { enabled: on });
    const keep = new SeenStore('ns2', backend, { enabled: on });
    s.note('bob', { host: 'h' });
    keep.note('eve', { host: 'h' });
    await s.flush();
    await keep.flush();
    await s.clear();
    expect(s.get('bob')).toBeUndefined();
    expect([...backend.rows.keys()]).toEqual(['ns2\u0001eve']);
  });
});

describe('registry', () => {
  afterEach(() => { __resetSeenRegistry(); });

  it('one store per namespace; clearAllSeen and sign-out wipe', async () => {
    const backend = new MemorySeenBackend();
    __resetSeenRegistry(backend);
    expect(seenNamespace('srv', 'u1')).toBe('u1::srv');
    expect(seenNamespace('srv', null)).toBe('guest::srv');
    const s1 = seenStoreFor('u1::srv');
    expect(seenStoreFor('u1::srv')).toBe(s1);
    const s2 = seenStoreFor('u2::srv');
    s1.note('bob', { host: 'h' });
    s2.note('eve', { host: 'h' });
    await s1.flush();
    await s2.flush();
    await wipeSeenForUser('u1');
    expect(s1.get('bob')).toBeUndefined();
    expect(s2.get('eve')).toBeDefined();
    expect([...backend.rows.keys()]).toEqual(['u2::srv\u0001eve']);
    await clearAllSeen();
    expect(s2.get('eve')).toBeUndefined();
    expect(backend.rows.size).toBe(0);
  });
});

describe('mergeSeen', () => {
  it('the newer record wins, the older fills gaps and its host becomes earlier', () => {
    const older: SeenRecord = { nick: 'bob', user: 'b', host: 'h1', realname: 'Bob', lastSeenAt: 1, channels: ['#a'] };
    const newer: SeenRecord = { nick: 'Bob', user: 'b', host: 'h2', lastSeenAt: 2, channels: ['#b'] };
    expect(mergeSeen(older, newer)).toEqual({
      nick: 'Bob', user: 'b', host: 'h2', realname: 'Bob', lastSeenAt: 2, channels: ['#b', '#a'], prevHosts: ['b@h1'],
    });
  });
});
