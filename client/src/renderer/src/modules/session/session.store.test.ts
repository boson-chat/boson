import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore, type SavedSession, type SavedServer } from './session.store';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    _map: map,
  };
}

const srvA: SavedServer = { id: 'srv-a', name: 'Boson HQ', hostname: 'irc.boson.dev', port: 6697, tls: true };
const srvB: SavedServer = { id: 'srv-b', name: 'Libera',   hostname: 'irc.libera.chat', port: 6697, tls: true };

const sampleSession: SavedSession = {
  servers: [
    { server: srvA, channels: ['#general', '#dev'], activeChannel: '#general' },
    { server: srvB, channels: ['#chat'],           activeChannel: '#chat' },
  ],
  activeServerId: 'srv-a',
};

describe('SessionStore (v2 multi-server)', () => {
  let storage: ReturnType<typeof makeStorage>;
  let store: SessionStore;

  beforeEach(() => {
    storage = makeStorage();
    store = new SessionStore(storage);
  });

  it('returns null when no session is saved', () => {
    expect(store.load()).toBeNull();
  });

  it('saves and loads round-trip', () => {
    store.save(sampleSession);
    expect(store.load()).toEqual(sampleSession);
  });

  it('clear() removes the saved session', () => {
    store.save(sampleSession);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('returns null when the stored value is corrupted JSON', () => {
    storage.setItem('boson:session:v2', '{not json');
    expect(store.load()).toBeNull();
  });

  it('returns null when the stored payload has the wrong shape', () => {
    storage.setItem('boson:session:v2', JSON.stringify({ foo: 'bar' }));
    expect(store.load()).toBeNull();
  });

  it('migrates a legacy v1 single-server payload on load', () => {
    storage.setItem('boson:session:v1', JSON.stringify({
      server: srvA,
      channels: ['#general'],
      activeChannel: '#general',
    }));
    const loaded = store.load();
    expect(loaded).toEqual({
      servers: [{ server: srvA, channels: ['#general'], activeChannel: '#general' }],
      activeServerId: 'srv-a',
    });
    // v1 record should have been removed, v2 record written through.
    expect(storage._map.get('boson:session:v1')).toBeUndefined();
    expect(storage._map.get('boson:session:v2')).toBeTruthy();
  });

  it('upsertServer appends a new server and promotes it active if none was', () => {
    store.upsertServer(srvA);
    const loaded = store.load();
    expect(loaded?.servers).toHaveLength(1);
    expect(loaded?.servers[0]?.server).toEqual(srvA);
    expect(loaded?.activeServerId).toBe('srv-a');
  });

  it('upsertServer refreshes an existing record without clobbering channels', () => {
    store.save({ ...sampleSession });
    const refreshed = { ...srvA, name: 'Renamed', hostname: 'irc.new.host' };
    store.upsertServer(refreshed);
    const loaded = store.load();
    expect(loaded?.servers.find((s) => s.server.id === 'srv-a')?.server).toEqual(refreshed);
    expect(loaded?.servers.find((s) => s.server.id === 'srv-a')?.channels).toEqual(['#general', '#dev']);
  });

  it('removeServer drops the entry and rolls activeServerId forward', () => {
    store.save(sampleSession);
    store.removeServer('srv-a');
    const loaded = store.load();
    expect(loaded?.servers.map((s) => s.server.id)).toEqual(['srv-b']);
    expect(loaded?.activeServerId).toBe('srv-b');
  });

  it('removeServer keeps activeServerId when removing a non-active server', () => {
    store.save(sampleSession);
    store.removeServer('srv-b');
    expect(store.load()?.activeServerId).toBe('srv-a');
  });

  it('setChannels targets a specific server', () => {
    store.save(sampleSession);
    store.setChannels('srv-b', ['#new', '#chat']);
    const loaded = store.load();
    expect(loaded?.servers.find((s) => s.server.id === 'srv-b')?.channels).toEqual(['#new', '#chat']);
    // Other server untouched.
    expect(loaded?.servers.find((s) => s.server.id === 'srv-a')?.channels).toEqual(['#general', '#dev']);
  });

  it('setActiveChannel targets a specific server', () => {
    store.save(sampleSession);
    store.setActiveChannel('srv-a', '#dev');
    expect(store.load()?.servers.find((s) => s.server.id === 'srv-a')?.activeChannel).toBe('#dev');
  });

  it('setActiveServer updates the rail anchor', () => {
    store.save(sampleSession);
    store.setActiveServer('srv-b');
    expect(store.load()?.activeServerId).toBe('srv-b');
  });

  it('mutators are no-ops when no session exists yet', () => {
    store.removeServer('srv-x');
    store.setChannels('srv-x', ['#x']);
    store.setActiveChannel('srv-x', '#x');
    store.setActiveServer('srv-x');
    expect(store.load()).toBeNull();
  });

  describe('per-server bouncer routing', () => {
    it('setServerBouncer persists and survives reload', () => {
      store.upsertServer(srvA);
      store.setServerBouncer('srv-a', { route: true, network: 'libera' });
      const reloaded = new SessionStore(storage).load();
      const got = reloaded!.servers.find((s) => s.server.id === 'srv-a')!.server;
      expect(got.bouncer).toEqual({ route: true, network: 'libera' });
    });

    it('upsertServer preserves bouncer across a host/name refresh', () => {
      store.upsertServer(srvA);
      store.setServerBouncer('srv-a', { route: true, network: 'libera' });
      // A directory refresh re-upserts without the bouncer field.
      store.upsertServer({ ...srvA, name: 'Renamed', hostname: 'irc.new.host' });
      const got = store.load()!.servers.find((s) => s.server.id === 'srv-a')!.server;
      expect(got.name).toBe('Renamed');
      expect(got.bouncer).toEqual({ route: true, network: 'libera' });
    });

    it('accepts saved payloads with and without bouncer; rejects malformed', () => {
      store.save({
        servers: [{ server: { ...srvA, bouncer: { route: false, network: '' } }, channels: [], activeChannel: null }],
        activeServerId: 'srv-a',
      });
      expect(store.load()!.servers[0]!.server.bouncer).toEqual({ route: false, network: '' });

      // Malformed bouncer → whole payload rejected (load returns null).
      const bad = makeStorage();
      bad.setItem('boson:session:v2', JSON.stringify({
        servers: [{ server: { ...srvA, bouncer: { route: 'yes' } }, channels: [], activeChannel: null }],
        activeServerId: 'srv-a',
      }));
      expect(new SessionStore(bad).load()).toBeNull();
    });
  });
});
