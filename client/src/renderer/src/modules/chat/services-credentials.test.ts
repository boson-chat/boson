import { describe, it, expect, beforeEach } from 'vitest';
import { LocalStorageServiceCredentialsStore, type ServiceCredentials } from './services-credentials';

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

  // ---- Extended shape (status, account name, email, generated, pending) ----

  it('round-trips all the new fields together', () => {
    store.set('libera', {
      nickservPassword: 'pw',
      accountName: 'alice',
      email: 'alice@example.com',
      status: 'identified',
      generatedPassword: true,
      pendingRegistration: { id: 't-1', email: 'reg-uid-t1@boson.chat' },
    });
    expect(store.get('libera')).toEqual({
      nickservPassword: 'pw',
      accountName: 'alice',
      email: 'alice@example.com',
      status: 'identified',
      generatedPassword: true,
      pendingRegistration: { id: 't-1', email: 'reg-uid-t1@boson.chat' },
    });
  });

  it('persists just a status field (no password yet — e.g. after a failed identify-without-creds)', () => {
    store.set('libera', { status: 'no-account' });
    expect(store.get('libera')?.status).toBe('no-account');
    expect(store.get('libera')?.nickservPassword).toBeUndefined();
  });

  it('treats an all-undefined object as a clear (legacy "empty save" behaviour preserved)', () => {
    store.set('libera', { nickservPassword: 'pw' });
    store.set('libera', {});
    expect(store.get('libera')).toBeNull();
  });

  it('loading a legacy entry (only nickservPassword) still works — the new fields default to undefined', () => {
    storage.setItem('boson.services-creds.libera', JSON.stringify({ nickservPassword: 'legacy-pw' }));
    const got = store.get('libera');
    expect(got?.nickservPassword).toBe('legacy-pw');
    expect(got?.status).toBeUndefined();
    expect(got?.generatedPassword).toBeUndefined();
  });

  // ---- subscribe() ----

  it('subscribe fires synchronously with the current value on mount', () => {
    store.set('libera', { nickservPassword: 'pw' });
    const seen: Array<ServiceCredentials | null> = [];
    store.subscribe('libera', (v) => { seen.push(v); });
    expect(seen).toEqual([{ nickservPassword: 'pw' }]);
  });

  it('subscribe fires null when the entry is missing', () => {
    const seen: Array<ServiceCredentials | null> = [];
    store.subscribe('libera', (v) => { seen.push(v); });
    expect(seen).toEqual([null]);
  });

  it('subscribe re-fires on set() with the new value', () => {
    const seen: Array<ServiceCredentials | null> = [];
    store.subscribe('libera', (v) => { seen.push(v); });
    store.set('libera', { nickservPassword: 'a' });
    store.set('libera', { nickservPassword: 'b' });
    // Initial null + 2 sets.
    expect(seen.length).toBe(3);
    expect(seen[1]?.nickservPassword).toBe('a');
    expect(seen[2]?.nickservPassword).toBe('b');
  });

  it('subscribe re-fires on clear() with null', () => {
    store.set('libera', { nickservPassword: 'pw' });
    const seen: Array<ServiceCredentials | null> = [];
    store.subscribe('libera', (v) => { seen.push(v); });
    store.clear('libera');
    expect(seen).toEqual([{ nickservPassword: 'pw' }, null]);
  });

  it('subscribe is scoped per serverId — mutations on libera do not fire oftc subscribers', () => {
    const oftcSeen: Array<ServiceCredentials | null> = [];
    store.subscribe('oftc', (v) => { oftcSeen.push(v); });
    store.set('libera', { nickservPassword: 'pw' });
    // Only the initial null from mount, no notifications from the libera write.
    expect(oftcSeen).toEqual([null]);
  });

  it('subscribe unsubscribe stops further fires', () => {
    const seen: Array<ServiceCredentials | null> = [];
    const off = store.subscribe('libera', (v) => { seen.push(v); });
    off();
    store.set('libera', { nickservPassword: 'pw' });
    // Only the initial null.
    expect(seen).toEqual([null]);
  });

  it('isolates a throwing subscriber from the others', () => {
    const seen: Array<ServiceCredentials | null> = [];
    store.subscribe('libera', () => { throw new Error('boom'); });
    store.subscribe('libera', (v) => { seen.push(v); });
    store.set('libera', { nickservPassword: 'pw' });
    expect(seen.length).toBe(2);
    expect(seen[1]?.nickservPassword).toBe('pw');
  });
});
