import { describe, it, expect, beforeEach } from 'vitest';
import { LocalStorageServiceCredentialsStore } from './services-credentials';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

describe('LocalStorageServiceCredentialsStore', () => {
  let storage: Storage;
  let store: LocalStorageServiceCredentialsStore;

  beforeEach(() => {
    storage = memStorage();
    store = new LocalStorageServiceCredentialsStore(storage);
  });

  it('returns null for a server with no saved credentials', () => {
    expect(store.get('libera')).toBeNull();
  });

  it('round-trips a saved nickserv password', () => {
    store.set('libera', { nickservPassword: 'hunter2' });
    expect(store.get('libera')).toEqual({ nickservPassword: 'hunter2' });
  });

  it('scopes credentials per serverId — saving on one server does not surface on another', () => {
    store.set('libera', { nickservPassword: 'a' });
    store.set('oftc', { nickservPassword: 'b' });
    expect(store.get('libera')?.nickservPassword).toBe('a');
    expect(store.get('oftc')?.nickservPassword).toBe('b');
  });

  it('clear() removes the entry', () => {
    store.set('libera', { nickservPassword: 'pw' });
    store.clear('libera');
    expect(store.get('libera')).toBeNull();
  });

  it('set() with an empty/whitespace-only payload acts as clear()', () => {
    store.set('libera', { nickservPassword: 'pw' });
    store.set('libera', { nickservPassword: '' });
    expect(store.get('libera')).toBeNull();
  });

  it('returns null when the stored entry is corrupt JSON, and self-heals by removing it', () => {
    storage.setItem('boson.services-creds.libera', '{not-valid-json');
    expect(store.get('libera')).toBeNull();
    // After the failed read the entry should be cleared.
    expect(storage.getItem('boson.services-creds.libera')).toBeNull();
  });

  it('returns null when the stored entry is a non-object JSON value', () => {
    storage.setItem('boson.services-creds.libera', JSON.stringify('just-a-string'));
    expect(store.get('libera')).toBeNull();
  });
});
