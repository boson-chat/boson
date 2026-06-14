import { describe, it, expect, beforeEach } from 'vitest';
import { BouncerSyncService, type BouncerSyncBackend } from './bouncer-sync.service';
import { SecureBouncerStore, type BouncerProfile } from './bouncer.store';
import { IdentityService } from '../identity/identity.service';
import type { ArgonFn } from '../identity/crypto';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { BouncerSecretDTO } from '../directory/directory.types';

const fastArgon: ArgonFn = (password, salt) => {
  const enc = new TextEncoder().encode(password);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (salt[i % salt.byteLength] ?? 0) ^ (enc[i % Math.max(enc.byteLength, 1)] ?? 0);
  }
  return out;
};

const profile: BouncerProfile = {
  enabled: true, host: 'znc.example.com', port: 6697, tls: true,
  tlsInsecure: false, username: 'me', password: 'pw',
};

class FakeBackend implements BouncerSyncBackend {
  stored: BouncerSecretDTO | null = null;
  puts: string[] = [];
  deletes = 0;
  async getBouncer(): Promise<BouncerSecretDTO | null> { return this.stored; }
  async putBouncer(ciphertext: string): Promise<void> {
    this.puts.push(ciphertext);
    this.stored = { ciphertext, updated_at: '2026-06-01T00:00:00Z' };
  }
  async deleteBouncer(): Promise<void> { this.deletes++; this.stored = null; }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function unlockedIdentity(): Promise<IdentityService> {
  const id = new IdentityService(fastArgon, new InMemorySecureStorage());
  await id.initializeForNewUser('login-pw');
  return id;
}

async function makeStore(): Promise<SecureBouncerStore> {
  const s = new SecureBouncerStore(new InMemorySecureStorage(), { probeIntervalMs: 1, probeTimeoutMs: 10 });
  await s.whenHydrated();
  return s;
}

describe('BouncerSyncService', () => {
  let identity: IdentityService;
  let store: SecureBouncerStore;
  let backend: FakeBackend;
  let metaSecure: InMemorySecureStorage;

  beforeEach(async () => {
    identity = await unlockedIdentity();
    store = await makeStore();
    backend = new FakeBackend();
    metaSecure = new InMemorySecureStorage();
  });

  const sync = () => new BouncerSyncService(identity, backend, store, metaSecure, 0);

  it('pull on unlock: decrypts the server profile into the local store', async () => {
    const ct = await identity.encryptBouncerProfile(profile);
    backend.stored = { ciphertext: ct, updated_at: '2026-06-01T00:00:00Z' };
    await sync().hydrateFromBackend();
    expect(store.get()).toEqual(profile);
  });

  it('push on local change: encrypts + PUTs the profile', async () => {
    const svc = sync();
    svc.start();
    await tick();
    store.set(profile);
    await tick();
    expect(backend.puts.length).toBeGreaterThanOrEqual(1);
    // Server now holds a blob that decrypts back to the profile.
    const back = await identity.decryptBouncerProfile(backend.stored!.ciphertext);
    expect(back).toEqual(profile);
  });

  it('clear after a sync: deletes the remote profile', async () => {
    const svc = sync();
    svc.start();
    await tick();
    store.set(profile);
    await tick();
    expect(backend.stored).not.toBeNull();
    store.clear();
    await tick();
    expect(backend.deletes).toBeGreaterThanOrEqual(1);
    expect(backend.stored).toBeNull();
  });

  it('no-ops while locked', async () => {
    identity.lock();
    backend.stored = { ciphertext: 'x', updated_at: '2026-06-01T00:00:00Z' };
    await sync().hydrateFromBackend();
    expect(store.get()).toBeNull(); // nothing pulled
    const svc = sync();
    svc.start();
    store.set(profile);
    await tick();
    expect(backend.puts.length).toBe(0); // nothing pushed
  });
});
