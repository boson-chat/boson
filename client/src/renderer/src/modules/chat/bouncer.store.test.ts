import { describe, it, expect } from 'vitest';
import { SecureBouncerStore, type BouncerProfile } from './bouncer.store';
import { InMemorySecureStorage } from '../../shared/secure-storage';

const profile: BouncerProfile = {
  enabled: true, host: 'znc.example.com', port: 6697, tls: true,
  tlsInsecure: false, username: 'me', password: 'pw',
};

const makeStore = async (backing = new InMemorySecureStorage()) => {
  const s = new SecureBouncerStore(backing, { probeIntervalMs: 1, probeTimeoutMs: 10 });
  await s.whenHydrated();
  return s;
};

describe('SecureBouncerStore', () => {
  it('starts empty and round-trips set/get', async () => {
    const s = await makeStore();
    expect(s.get()).toBeNull();
    s.set(profile);
    expect(s.get()).toEqual(profile);
  });

  it('clear() removes the profile', async () => {
    const s = await makeStore();
    s.set(profile);
    s.clear();
    expect(s.get()).toBeNull();
  });

  it('persists across instances sharing the same backing', async () => {
    const backing = new InMemorySecureStorage();
    const s1 = await makeStore(backing);
    s1.set(profile);
    // Let the write chain flush.
    await new Promise((r) => setTimeout(r, 5));
    const s2 = await makeStore(backing);
    expect(s2.get()).toEqual(profile);
  });

  it('subscribe fires immediately and on change', async () => {
    const s = await makeStore();
    const seen: (BouncerProfile | null)[] = [];
    s.subscribe((p) => seen.push(p));
    expect(seen).toEqual([null]); // initial
    s.set(profile);
    expect(seen[seen.length - 1]).toEqual(profile);
  });
});
