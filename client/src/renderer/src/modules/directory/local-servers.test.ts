import { describe, it, expect, beforeEach } from 'vitest';
import {
  addLocalServer,
  loadLocalServers,
  removeLocalServer,
  asDirectoryServer,
  mergeWithLocal,
} from './local-servers';

const STORAGE_KEY = 'boson:local-servers:v1';

describe('local-servers', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('round-trips a server with tlsInsecure set', () => {
    const created = addLocalServer({
      name: 'My IRCd',
      hostname: '192.168.1.10',
      port: 6697,
      tls: true,
      tlsInsecure: true,
    });
    expect(created.tlsInsecure).toBe(true);
    const loaded = loadLocalServers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.tlsInsecure).toBe(true);
  });

  it('omits tlsInsecure when not provided (defaults to undefined)', () => {
    addLocalServer({ name: 'plain', hostname: 'irc.example.org', port: 6697, tls: true });
    expect(loadLocalServers()[0]!.tlsInsecure).toBeUndefined();
  });

  it('idempotent on hostname+port — re-adding updates the tlsInsecure flag in place', () => {
    const first = addLocalServer({ name: 'a', hostname: 'irc.h', port: 6697, tls: true, tlsInsecure: false });
    const second = addLocalServer({ name: 'a', hostname: 'irc.h', port: 6697, tls: true, tlsInsecure: true });
    expect(second.id).toBe(first.id);
    const loaded = loadLocalServers();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.tlsInsecure).toBe(true);
  });

  it('drops a persisted entry whose tlsInsecure is the wrong type', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: 'local-ok', name: 'ok', hostname: 'a', port: 1, tls: true, tlsInsecure: true },
        { id: 'local-bad', name: 'bad', hostname: 'b', port: 2, tls: true, tlsInsecure: 'yes' },
      ]),
    );
    const loaded = loadLocalServers();
    expect(loaded.map((s) => s.id)).toEqual(['local-ok']);
  });

  it('asDirectoryServer carries hostname/port/tls through (tlsInsecure stays on the local record)', () => {
    const created = addLocalServer({ name: 'x', hostname: 'irc.h', port: 6697, tls: true, tlsInsecure: true });
    const dir = asDirectoryServer(created);
    expect(dir.id).toBe(created.id);
    expect(dir.hostname).toBe('irc.h');
    expect(dir.tls).toBe(true);
  });

  it('removeLocalServer drops the entry by id', () => {
    const created = addLocalServer({ name: 'x', hostname: 'irc.h', port: 6697, tls: true, tlsInsecure: true });
    removeLocalServer(created.id);
    expect(loadLocalServers()).toHaveLength(0);
  });

  describe('mergeWithLocal', () => {
    const backend = asDirectoryServer({ id: 'b1', name: 'Listed', hostname: 'IRC.Example.org', port: 6697, tls: true });

    it('hides a local entry for the same hostname:port (backend wins)', () => {
      const local = addLocalServer({ name: 'mine', hostname: 'irc.example.org', port: 6697, tls: true });
      const merged = mergeWithLocal([backend], [local]);
      expect(merged.map((s) => s.id)).toEqual(['b1']);
    });

    // Regression: the merge keyed on hostname alone, so a local entry for a
    // different port on a listed host vanished from the directory — and a
    // boson://join deep link to that port silently did nothing.
    it('keeps a local entry for another port on a listed host', () => {
      const local = addLocalServer({ name: 'plain', hostname: 'irc.example.org', port: 6667, tls: false });
      const merged = mergeWithLocal([backend], [local]);
      expect(merged.map((s) => s.id)).toEqual(['b1', local.id]);
    });
  });
});
