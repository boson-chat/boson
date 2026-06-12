import { describe, it, expect, beforeEach } from 'vitest';
import { NickservSyncService, type NickservSyncBackend } from './nickserv-sync.service';
import { SecureServiceCredentialsStore } from './services-credentials';
import { IdentityService } from '../identity/identity.service';
import type { ArgonFn } from '../identity/crypto';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import type { NickservSecretDTO } from '../directory/directory.types';

const fastArgon: ArgonFn = (password, salt) => {
  const enc = new TextEncoder().encode(password);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (salt[i % salt.byteLength] ?? 0) ^ (enc[i % Math.max(enc.byteLength, 1)] ?? 0);
  }
  return out;
};

class FakeBackend implements NickservSyncBackend {
  secrets = new Map<string, NickservSecretDTO>();
  puts: Array<{ serverId: string; ciphertext: string }> = [];
  deletes: string[] = [];
  async listNickservSecrets(): Promise<NickservSecretDTO[]> {
    return [...this.secrets.values()];
  }
  async putNickservSecret(serverId: string, ciphertext: string): Promise<void> {
    this.puts.push({ serverId, ciphertext });
    this.secrets.set(serverId, { server_id: serverId, ciphertext, updated_at: '2026-06-01T00:00:00Z' });
  }
  async deleteNickservSecret(serverId: string): Promise<void> {
    this.deletes.push(serverId);
    this.secrets.delete(serverId);
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function makeUnlockedIdentity(): Promise<IdentityService> {
  const id = new IdentityService(fastArgon, new InMemorySecureStorage());
  await id.initializeForNewUser('login-pw');
  return id;
}

async function makeStore(): Promise<SecureServiceCredentialsStore> {
  const s = new SecureServiceCredentialsStore(new InMemorySecureStorage(), null);
  await s.whenHydrated();
  return s;
}

describe('NickservSyncService — pull / merge', () => {
  let identity: IdentityService;
  let store: SecureServiceCredentialsStore;
  let backend: FakeBackend;
  let metaSecure: InMemorySecureStorage;

  beforeEach(async () => {
    identity = await makeUnlockedIdentity();
    store = await makeStore();
    backend = new FakeBackend();
    metaSecure = new InMemorySecureStorage();
  });

  function sync(): NickservSyncService {
    return new NickservSyncService(identity, backend, store, metaSecure, 0);
  }

  it('fresh device: decrypts server secrets into the local store', async () => {
    const ct = await identity.encryptCredsForServer('srv-1', { nickservPassword: 'pw1', accountName: 'Nyan' });
    backend.secrets.set('srv-1', { server_id: 'srv-1', ciphertext: ct, updated_at: '2026-06-01T00:00:00Z' });

    await sync().hydrateFromBackend();

    const creds = store.get('srv-1');
    expect(creds?.nickservPassword).toBe('pw1');
    expect(creds?.accountName).toBe('Nyan');
  });

  it('preserves local non-synced fields (status/email) when taking the server value', async () => {
    store.set('srv-1', { status: 'identified', email: 'me@x.com' }); // no password locally
    const ct = await identity.encryptCredsForServer('srv-1', { nickservPassword: 'pw1' });
    backend.secrets.set('srv-1', { server_id: 'srv-1', ciphertext: ct, updated_at: '2026-06-01T00:00:00Z' });

    await sync().hydrateFromBackend();

    const creds = store.get('srv-1');
    expect(creds?.nickservPassword).toBe('pw1');
    expect(creds?.status).toBe('identified');
    expect(creds?.email).toBe('me@x.com');
  });

  it('a decrypt failure on one entry is skipped and local is preserved', async () => {
    store.set('srv-1', { nickservPassword: 'local-pw' });
    // Garbage ciphertext that cannot decrypt under our key.
    backend.secrets.set('srv-1', { server_id: 'srv-1', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==', updated_at: '2099-01-01T00:00:00Z' });

    await sync().hydrateFromBackend();

    expect(store.get('srv-1')?.nickservPassword).toBe('local-pw'); // untouched
  });

  it('local newer than last-sync wins over an older server copy (and pushes)', async () => {
    // Seed meta so this device "last synced" srv-1 far in the future.
    await metaSecure.set('boson.nickserv-sync.meta', JSON.stringify({ 'srv-1': 4102444800000 }));
    store.set('srv-1', { nickservPassword: 'local-pw' });
    const stale = await identity.encryptCredsForServer('srv-1', { nickservPassword: 'old-remote' });
    backend.secrets.set('srv-1', { server_id: 'srv-1', ciphertext: stale, updated_at: '2020-01-01T00:00:00Z' });

    await sync().hydrateFromBackend();

    expect(store.get('srv-1')?.nickservPassword).toBe('local-pw'); // local kept
    expect(backend.puts.some((p) => p.serverId === 'srv-1')).toBe(true); // and pushed up
  });

  it('pushes local-only servers absent from the backend', async () => {
    store.set('srv-2', { nickservPassword: 'only-local' });
    await sync().hydrateFromBackend();
    expect(backend.puts.some((p) => p.serverId === 'srv-2')).toBe(true);
  });

  it('no-op when identity is locked', async () => {
    identity.lock();
    backend.secrets.set('srv-1', { server_id: 'srv-1', ciphertext: 'x', updated_at: '2026-06-01T00:00:00Z' });
    await sync().hydrateFromBackend();
    expect(store.get('srv-1')).toBeNull();
  });
});

describe('NickservSyncService — push / write-through', () => {
  let identity: IdentityService;
  let store: SecureServiceCredentialsStore;
  let backend: FakeBackend;

  beforeEach(async () => {
    identity = await makeUnlockedIdentity();
    store = await makeStore();
    backend = new FakeBackend();
  });

  it('pushes a debounced PUT when a password is saved while unlocked', async () => {
    const svc = new NickservSyncService(identity, backend, store, new InMemorySecureStorage(), 0);
    svc.start();
    await tick(); // let start()'s initial (empty) pull settle

    store.set('srv-1', { nickservPassword: 'new-pw', accountName: 'Nyan' });
    await tick();

    const forSrv1 = backend.puts.filter((p) => p.serverId === 'srv-1');
    expect(forSrv1).toHaveLength(1);
    // Round-trips: the pushed ciphertext decrypts back to what we saved.
    const decrypted = await identity.decryptCredsForServer('srv-1', forSrv1[0]!.ciphertext);
    expect(decrypted).toEqual({ nickservPassword: 'new-pw', accountName: 'Nyan' });
    svc.dispose();
  });

  it('does not push while locked', async () => {
    const svc = new NickservSyncService(identity, backend, store, new InMemorySecureStorage(), 0);
    svc.start();
    await tick();
    identity.lock();

    store.set('srv-1', { nickservPassword: 'new-pw' });
    await tick();

    expect(backend.puts).toHaveLength(0);
    svc.dispose();
  });

  it('no-op push when the keychain backing is unavailable', async () => {
    const unavailable = new InMemorySecureStorage();
    // Force isAvailable=false.
    (unavailable as unknown as { isAvailable: () => Promise<boolean> }).isAvailable = async () => false;
    const svc = new NickservSyncService(identity, backend, store, unavailable, 0);
    svc.start();
    await tick();
    store.set('srv-1', { nickservPassword: 'pw' });
    await tick();
    expect(backend.puts).toHaveLength(0);
    svc.dispose();
  });
});
