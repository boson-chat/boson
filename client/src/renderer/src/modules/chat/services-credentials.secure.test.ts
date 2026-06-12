import { describe, it, expect } from 'vitest';
import {
  SecureServiceCredentialsStore,
  type ServiceCredentials,
} from './services-credentials';
import { InMemorySecureStorage, type SecureStorage } from '../../shared/secure-storage';

// Mirrors the module-private constant in services-credentials.ts.
const SECURE_KEY = 'boson.services-creds.v1';
const LEGACY_PREFIX = 'boson.services-creds.';

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

describe('SecureServiceCredentialsStore', () => {
  it('serves reads synchronously from the cache and round-trips through SecureStorage', async () => {
    const secure = new InMemorySecureStorage();
    const a = new SecureServiceCredentialsStore(secure, memStorage());
    await a.whenHydrated();

    const creds: ServiceCredentials = {
      nickservPassword: 'gen-pw',
      accountName: 'Nyan',
      status: 'identified',
      generatedPassword: true,
    };
    a.set('srv-1', creds);
    expect(a.get('srv-1')).toEqual(creds); // sync read from cache
    await a.flush();

    // A fresh store over the same backing hydrates the same data.
    const b = new SecureServiceCredentialsStore(secure, memStorage());
    await b.whenHydrated();
    expect(b.get('srv-1')).toEqual(creds);
  });

  it('treats an all-empty creds object as clear()', async () => {
    const secure = new InMemorySecureStorage();
    const s = new SecureServiceCredentialsStore(secure, memStorage());
    await s.whenHydrated();
    s.set('srv-1', { nickservPassword: 'pw' });
    expect(s.get('srv-1')).not.toBeNull();
    s.set('srv-1', {}); // empty → clear
    expect(s.get('srv-1')).toBeNull();
  });

  it('notifies subscribers synchronously and re-emits once hydration completes', async () => {
    const secure = new InMemorySecureStorage();
    await secure.set(SECURE_KEY, JSON.stringify({
      'srv-1': { accountName: 'Nyan', status: 'identified' },
    }));
    const s = new SecureServiceCredentialsStore(secure, memStorage());

    const seen: (ServiceCredentials | null)[] = [];
    s.subscribe('srv-1', (v) => seen.push(v));
    // Initial synchronous fire happens before hydration → null.
    expect(seen[0]).toBeNull();

    await s.whenHydrated();
    // Re-emitted with the hydrated value so a pre-hydration subscriber settles.
    expect(seen.at(-1)).toEqual({ accountName: 'Nyan', status: 'identified' });
  });

  it('per-server fan-out: a write to server B does not notify server A subscribers', async () => {
    const secure = new InMemorySecureStorage();
    const s = new SecureServiceCredentialsStore(secure, memStorage());
    await s.whenHydrated();

    const aCalls: (ServiceCredentials | null)[] = [];
    s.subscribe('srv-A', (v) => aCalls.push(v));
    const baseline = aCalls.length;
    s.set('srv-B', { accountName: 'Other' });
    expect(aCalls.length).toBe(baseline); // unchanged
  });
});

describe('SecureServiceCredentialsStore — legacy migration', () => {
  it('migrates plain-text localStorage entries into SecureStorage and scrubs them', async () => {
    const legacy = memStorage();
    legacy.setItem(LEGACY_PREFIX + 'srv-1', JSON.stringify({
      nickservPassword: 'plaintext-pw',
      accountName: 'Nyan',
      status: 'identified',
    }));
    const secure = new InMemorySecureStorage();
    const s = new SecureServiceCredentialsStore(secure, legacy);
    await s.whenHydrated();

    // Available in the cache via the normal sync API.
    expect(s.get('srv-1')).toEqual({
      nickservPassword: 'plaintext-pw',
      accountName: 'Nyan',
      status: 'identified',
    });
    // Plain-text legacy entry scrubbed from disk.
    expect(legacy.getItem(LEGACY_PREFIX + 'srv-1')).toBeNull();
    // Now persisted (encrypted in prod) under the secure key.
    const stored = await secure.get(SECURE_KEY);
    expect(stored).toContain('plaintext-pw');
  });

  it('secure copy wins over a stale legacy dupe, and the dupe is scrubbed', async () => {
    const legacy = memStorage();
    legacy.setItem(LEGACY_PREFIX + 'srv-1', JSON.stringify({ nickservPassword: 'old' }));
    const secure = new InMemorySecureStorage();
    await secure.set(SECURE_KEY, JSON.stringify({ 'srv-1': { nickservPassword: 'new' } }));

    const s = new SecureServiceCredentialsStore(secure, legacy);
    await s.whenHydrated();

    expect(s.get('srv-1')?.nickservPassword).toBe('new');
    expect(legacy.getItem(LEGACY_PREFIX + 'srv-1')).toBeNull();
  });

  it('rides out a late-arriving secure backing (preload injection race) and still migrates', async () => {
    const legacy = memStorage();
    legacy.setItem(LEGACY_PREFIX + 'srv-1', JSON.stringify({ nickservPassword: 'pw' }));
    const inner = new InMemorySecureStorage();
    let ready = false; // bridge not injected yet at construction
    const flaky: SecureStorage = {
      isAvailable: async () => ready,
      get: (k) => inner.get(k),
      set: (k, v) => inner.set(k, v),
      remove: (k) => inner.remove(k),
    };
    const s = new SecureServiceCredentialsStore(flaky, legacy, { probeIntervalMs: 10, probeTimeoutMs: 2000 });
    // Bridge becomes available a few probes in.
    setTimeout(() => { ready = true; }, 35);

    await s.whenHydrated();
    expect(s.get('srv-1')?.nickservPassword).toBe('pw');
    expect(legacy.getItem(LEGACY_PREFIX + 'srv-1')).toBeNull(); // migrated + scrubbed
  });

  it('does NOT scrub legacy when the secure backing is unavailable (never destroys the only copy)', async () => {
    const legacy = memStorage();
    legacy.setItem(LEGACY_PREFIX + 'srv-1', JSON.stringify({ nickservPassword: 'pw' }));

    // Secure storage that reports unavailable.
    const unavailable: SecureStorage = {
      isAvailable: async () => false,
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    };
    // probeTimeoutMs: 0 → probe once, give up immediately (no 3s wait).
    const s = new SecureServiceCredentialsStore(unavailable, legacy, { probeTimeoutMs: 0 });
    await s.whenHydrated();

    // Legacy plain-text left intact rather than lost.
    expect(legacy.getItem(LEGACY_PREFIX + 'srv-1')).not.toBeNull();
  });
});
