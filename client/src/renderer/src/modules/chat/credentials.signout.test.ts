// Sign-out and the synced credentials (NickServ passwords, the bouncer
// profile): the wipe must not be pushed to A's account as deletes, and none
// of A's credentials may be pushed into B's account when B signs in next.
import { describe, it, expect } from 'vitest';
import { NickservSyncService, type NickservSyncBackend } from './nickserv-sync.service';
import { BouncerSyncService, type BouncerSyncBackend } from './bouncer-sync.service';
import { SecureServiceCredentialsStore } from './services-credentials';
import { SecureBouncerStore } from './bouncer.store';
import { IdentityService } from '../identity/identity.service';
import type { ArgonFn } from '../identity/crypto';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { BouncerSecretDTO, NickservSecretDTO } from '../directory/directory.types';

const fastArgon: ArgonFn = (password, salt) => {
  const enc = new TextEncoder().encode(password);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (salt[i % salt.byteLength] ?? 0) ^ (enc[i % Math.max(enc.byteLength, 1)] ?? 0);
  return out;
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

class NickBackend implements NickservSyncBackend {
  secrets = new Map<string, NickservSecretDTO>();
  puts: string[] = [];
  deletes: string[] = [];
  async listNickservSecrets() { return [...this.secrets.values()]; }
  async putNickservSecret(serverId: string, ciphertext: string) {
    this.puts.push(serverId);
    this.secrets.set(serverId, { server_id: serverId, ciphertext, updated_at: '2026-06-01T00:00:00Z' });
  }
  async deleteNickservSecret(serverId: string) { this.deletes.push(serverId); this.secrets.delete(serverId); }
}

class BncBackend implements BouncerSyncBackend {
  stored: BouncerSecretDTO | null = null;
  puts = 0;
  deletes = 0;
  async getBouncer() { return this.stored; }
  async putBouncer(ciphertext: string) { this.puts++; this.stored = { ciphertext, updated_at: '2026-06-01T00:00:00Z' }; }
  async deleteBouncer() { this.deletes++; this.stored = null; }
}

describe('credential stores on sign-out', () => {
  it("NickServ passwords: A's stay in A's account, and B's account never gets them", async () => {
    const identity = new IdentityService(fastArgon, new InMemorySecureStorage());
    const secure = new InMemorySecureStorage();
    const store = new SecureServiceCredentialsStore(secure, null, { probeIntervalMs: 1, probeTimeoutMs: 10 });
    await store.whenHydrated();
    const backendA = new NickBackend();
    let backend: NickBackend = backendA;
    const sync = new NickservSyncService(identity, { listNickservSecrets: () => backend.listNickservSecrets(), putNickservSecret: (s, c) => backend.putNickservSecret(s, c), deleteNickservSecret: (s) => backend.deleteNickservSecret(s) }, store, new InMemorySecureStorage(), 0);
    sync.start();
    await identity.initializeForNewUser('alice-pw');
    store.set('libera', { nickservPassword: 'alice-secret', accountName: 'alice' });
    await tick();
    expect(backendA.puts).toContain('libera');

    // The sign-out's order: stop syncing, lock, then wipe.
    sync.clearForSignOut();
    identity.lock();
    await store.clearForSignOut();
    await tick();
    expect(backendA.deletes).toEqual([]);
    expect(backendA.secrets.has('libera')).toBe(true);
    expect(store.get('libera')).toBeNull();
    expect(await secure.get('boson.services-creds.v1')).toBeNull();

    // B signs in on the same device.
    const backendB = new NickBackend();
    backend = backendB;
    await identity.initializeForNewUser('bob-pw');
    await tick();
    expect(backendB.puts).toEqual([]);
    expect(store.get('libera')).toBeNull();
  });

  it("the bouncer profile: not deleted from A's account, not pushed into B's", async () => {
    const identity = new IdentityService(fastArgon, new InMemorySecureStorage());
    const secure = new InMemorySecureStorage();
    const store = new SecureBouncerStore(secure, { probeIntervalMs: 1, probeTimeoutMs: 10 });
    await store.whenHydrated();
    const a = new BncBackend();
    let backend: BncBackend = a;
    const sync = new BouncerSyncService(identity, { getBouncer: () => backend.getBouncer(), putBouncer: (c) => backend.putBouncer(c), deleteBouncer: () => backend.deleteBouncer() }, store, new InMemorySecureStorage(), 0);
    sync.start();
    await identity.initializeForNewUser('alice-pw');
    store.set({ enabled: true, host: 'znc.example', port: 7000, tls: true, tlsInsecure: false, username: 'alice', password: 'zncpw' });
    await tick();
    expect(a.puts).toBeGreaterThan(0);

    sync.clearForSignOut();
    identity.lock();
    await store.clearForSignOut();
    await tick();
    expect(a.deletes).toBe(0);
    expect(store.get()).toBeNull();
    expect(await secure.get('boson.bouncer.v1')).toBeNull();

    const b = new BncBackend();
    backend = b;
    await identity.initializeForNewUser('bob-pw');
    await tick();
    expect(b.puts).toBe(0);
  });

  it('a write still queued when sign-out starts does not bring the credentials back', async () => {
    let release!: () => void;
    const inner = new InMemorySecureStorage();
    const slow = {
      isAvailable: async () => true,
      get: (k: string) => inner.get(k),
      set: async (k: string, v: string) => { await new Promise<void>((r) => { release = r; }); await inner.set(k, v); },
      remove: (k: string) => inner.remove(k),
    };
    const store = new SecureServiceCredentialsStore(slow, null, { probeIntervalMs: 1, probeTimeoutMs: 10 });
    await store.whenHydrated();
    store.set('libera', { nickservPassword: 'pw' });
    const done = store.clearForSignOut();
    await tick(5);
    release();
    await done;
    expect(await inner.get('boson.services-creds.v1')).toBeNull();
  });
});
