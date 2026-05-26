import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityService } from './identity.service';
import type { ArgonFn } from './crypto';
import { InMemorySecureStorage, type SecureStorage } from '../../shared/secure-storage';
import { base64Encode } from './crypto';

// Same fast deterministic KDF as crypto.test.ts.
const fastArgon: ArgonFn = (password, salt) => {
  const enc = new TextEncoder().encode(password);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (salt[i % salt.byteLength] ?? 0) ^ (enc[i % Math.max(enc.byteLength, 1)] ?? 0);
  }
  return out;
};

function makeSvc(): IdentityService { return new IdentityService(fastArgon); }

describe('IdentityService', () => {
  let svc: IdentityService;
  beforeEach(() => { svc = makeSvc(); });

  it('starts locked', () => {
    expect(svc.isUnlocked()).toBe(false);
    expect(svc.getState().status).toBe('locked');
  });

  it('initializeForNewUser unlocks and exposes an encrypted blob', async () => {
    const blob = await svc.initializeForNewUser('hunter2');
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getState().status).toBe('unlocked');
    expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(svc.getPendingEncrypted()).toBe(blob);
  });

  it('a fresh service can unlock the blob produced by another with the same password', async () => {
    const setup = makeSvc();
    const blob = await setup.initializeForNewUser('hunter2');

    const fresh = makeSvc();
    await expect(fresh.unlock('hunter2', blob)).resolves.toBeUndefined();
    expect(fresh.isUnlocked()).toBe(true);
  });

  it('wrong password keeps the service locked and surfaces an error', async () => {
    const setup = makeSvc();
    const blob = await setup.initializeForNewUser('hunter2');

    const fresh = makeSvc();
    await expect(fresh.unlock('wrong', blob)).rejects.toThrow();
    expect(fresh.isUnlocked()).toBe(false);
    expect(fresh.getState().status).toBe('locked');
    expect(fresh.getState().error).toBeTruthy();
  });

  it('saslPasswordForServer is deterministic and per-server', async () => {
    await svc.initializeForNewUser('hunter2');
    const a1 = await svc.saslPasswordForServer('server-a');
    const a2 = await svc.saslPasswordForServer('server-a');
    const b1 = await svc.saslPasswordForServer('server-b');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
  });

  it('saslPasswordForServer throws when locked', async () => {
    await expect(svc.saslPasswordForServer('server-a')).rejects.toThrow(/locked/);
  });

  it('lock() clears the secret and the pending blob', async () => {
    await svc.initializeForNewUser('hunter2');
    expect(svc.isUnlocked()).toBe(true);
    expect(svc.getPendingEncrypted()).not.toBeNull();
    svc.lock();
    expect(svc.isUnlocked()).toBe(false);
    expect(svc.getPendingEncrypted()).toBeNull();
  });

  it('subscribe fires immediately with the current state', async () => {
    const seen: string[] = [];
    svc.subscribe((s) => seen.push(s.status));
    expect(seen).toEqual(['locked']);

    await svc.initializeForNewUser('hunter2');
    expect(seen.at(-1)).toBe('unlocked');

    svc.lock();
    expect(seen.at(-1)).toBe('locked');
  });

  it('unsubscribe stops notifications', async () => {
    const seen: string[] = [];
    const off = svc.subscribe((s) => seen.push(s.status));
    off();
    await svc.initializeForNewUser('hunter2');
    expect(seen).toEqual(['locked']); // no further updates
  });

  it('clearPendingEncrypted does not lock the service', async () => {
    await svc.initializeForNewUser('hunter2');
    svc.clearPendingEncrypted();
    expect(svc.getPendingEncrypted()).toBeNull();
    expect(svc.isUnlocked()).toBe(true);
  });

  it('cross-instance round-trip: re-unlock with the right password yields the same SASL password', async () => {
    const a = makeSvc();
    const blob = await a.initializeForNewUser('hunter2');
    const aPwd = await a.saslPasswordForServer('s1');

    const b = makeSvc();
    await b.unlock('hunter2', blob);
    const bPwd = await b.saslPasswordForServer('s1');

    expect(bPwd).toBe(aPwd);
  });

  describe('keychain persistence', () => {
    // Reach inside the service for direct access to the in-memory secret —
    // the only way to assert "the persisted blob equals the unlocked secret"
    // without exposing the secret on the public API.
    function readSecret(s: IdentityService): Uint8Array | null {
      return (s as unknown as { userSecret: Uint8Array | null }).userSecret;
    }

    it('persist() writes the base64-encoded in-memory secret under the namespaced key', async () => {
      const storage = new InMemorySecureStorage();
      const svc = new IdentityService(fastArgon, storage);
      await svc.initializeForNewUser('hunter2');
      const before = readSecret(svc);
      expect(before).not.toBeNull();

      const ok = await svc.persist('user-123');
      expect(ok).toBe(true);

      const stored = await storage.get('boson.identity.user-123');
      expect(stored).not.toBeNull();
      expect(stored).toBe(base64Encode(before!));
    });

    it('persist() returns false when the service is locked', async () => {
      const storage = new InMemorySecureStorage();
      const svc = new IdentityService(fastArgon, storage);
      // Never unlocked.
      const ok = await svc.persist('user-123');
      expect(ok).toBe(false);
      expect(await storage.get('boson.identity.user-123')).toBeNull();
    });

    it('persist() returns false when SecureStorage reports unavailable', async () => {
      const unavailable: SecureStorage = {
        isAvailable: async () => false,
        get: async () => null,
        set: async () => { throw new Error('should not be called'); },
        remove: async () => {},
      };
      const svc = new IdentityService(fastArgon, unavailable);
      await svc.initializeForNewUser('hunter2');
      expect(await svc.persist('user-123')).toBe(false);
    });

    it('restoreFromStorage() reads the stored blob, transitions to unlocked, and emits', async () => {
      const storage = new InMemorySecureStorage();
      // Seed storage with a fresh secret produced by another service instance,
      // simulating a previous session that called persist().
      const seeder = new IdentityService(fastArgon, storage);
      await seeder.initializeForNewUser('hunter2');
      await seeder.persist('user-123');
      const seederPwd = await seeder.saslPasswordForServer('s1');

      const svc = new IdentityService(fastArgon, storage);
      const seen: string[] = [];
      svc.subscribe((s) => seen.push(s.status));
      expect(svc.isUnlocked()).toBe(false);

      const ok = await svc.restoreFromStorage('user-123');
      expect(ok).toBe(true);
      expect(svc.isUnlocked()).toBe(true);
      expect(svc.getState().status).toBe('unlocked');
      // Initial state + transition to unlocked = two notifications.
      expect(seen.at(-1)).toBe('unlocked');

      // Round-trip: the restored secret must yield the same SASL password.
      const restoredPwd = await svc.saslPasswordForServer('s1');
      expect(restoredPwd).toBe(seederPwd);
    });

    it('restoreFromStorage() with no stored blob returns false and stays locked', async () => {
      const storage = new InMemorySecureStorage();
      const svc = new IdentityService(fastArgon, storage);
      const ok = await svc.restoreFromStorage('user-without-blob');
      expect(ok).toBe(false);
      expect(svc.isUnlocked()).toBe(false);
      expect(svc.getState().status).toBe('locked');
    });

    it('restoreFromStorage() returns false when SecureStorage is unavailable', async () => {
      const unavailable: SecureStorage = {
        isAvailable: async () => false,
        get: async () => 'should-not-be-read',
        set: async () => {},
        remove: async () => {},
      };
      const svc = new IdentityService(fastArgon, unavailable);
      expect(await svc.restoreFromStorage('user-123')).toBe(false);
      expect(svc.isUnlocked()).toBe(false);
    });

    it('restoreFromStorage() rejects a stored value with the wrong byte length', async () => {
      // Hand-craft storage that returns a 4-byte payload; the service should
      // refuse it rather than blindly treating any-length data as a user_secret.
      const storage: SecureStorage = {
        isAvailable: async () => true,
        get: async () => base64Encode(new Uint8Array([1, 2, 3, 4])),
        set: async () => {},
        remove: async () => {},
      };
      const svc = new IdentityService(fastArgon, storage);
      expect(await svc.restoreFromStorage('user-123')).toBe(false);
      expect(svc.isUnlocked()).toBe(false);
    });

    it('clearStorage() removes the namespaced entry', async () => {
      const storage = new InMemorySecureStorage();
      const svc = new IdentityService(fastArgon, storage);
      await svc.initializeForNewUser('hunter2');
      await svc.persist('user-123');
      expect(await storage.get('boson.identity.user-123')).not.toBeNull();

      await svc.clearStorage('user-123');
      expect(await storage.get('boson.identity.user-123')).toBeNull();
    });

    it('lock() does NOT clear persisted storage', async () => {
      // Locking is in-memory only — that's how cross-launch persistence works.
      // Only sign-out should drop the keychain entry, via clearStorage().
      const storage = new InMemorySecureStorage();
      const svc = new IdentityService(fastArgon, storage);
      await svc.initializeForNewUser('hunter2');
      await svc.persist('user-123');

      svc.lock();
      expect(svc.isUnlocked()).toBe(false);
      // The stored entry is still there for the next launch.
      expect(await storage.get('boson.identity.user-123')).not.toBeNull();
    });

    it('persist + restore is independent of password — the keychain bypasses Argon2id', async () => {
      // Once the secret is in the keychain, restoring it does not require the
      // user's password. This is the whole point of the feature.
      const storage = new InMemorySecureStorage();
      const a = new IdentityService(fastArgon, storage);
      await a.initializeForNewUser('hunter2');
      await a.persist('user-123');
      const aPwd = await a.saslPasswordForServer('s1');

      const b = new IdentityService(fastArgon, storage);
      const ok = await b.restoreFromStorage('user-123');
      expect(ok).toBe(true);
      // No call to unlock(password). SASL still works.
      expect(await b.saslPasswordForServer('s1')).toBe(aPwd);
    });

    it('persist() namespaces by userId so multiple accounts on one machine do not collide', async () => {
      const storage = new InMemorySecureStorage();
      const aliceSvc = new IdentityService(fastArgon, storage);
      await aliceSvc.initializeForNewUser('alice-pw');
      await aliceSvc.persist('alice-id');

      const bobSvc = new IdentityService(fastArgon, storage);
      await bobSvc.initializeForNewUser('bob-pw');
      await bobSvc.persist('bob-id');

      expect(await storage.get('boson.identity.alice-id')).not.toBeNull();
      expect(await storage.get('boson.identity.bob-id')).not.toBeNull();
      expect(await storage.get('boson.identity.alice-id'))
        .not.toBe(await storage.get('boson.identity.bob-id'));
    });

    it('persist() with empty userId is a no-op (returns false, writes nothing)', async () => {
      const storage = new InMemorySecureStorage();
      const svc = new IdentityService(fastArgon, storage);
      await svc.initializeForNewUser('hunter2');
      expect(await svc.persist('')).toBe(false);
    });

    it('survives storage errors without throwing — persist() returns false', async () => {
      const flaky: SecureStorage = {
        isAvailable: async () => true,
        get: async () => null,
        set: async () => { throw new Error('keychain offline'); },
        remove: async () => {},
      };
      const svc = new IdentityService(fastArgon, flaky);
      await svc.initializeForNewUser('hunter2');
      // Should NOT propagate — sign-in must keep working even if the keychain
      // briefly fails.
      await expect(svc.persist('user-123')).resolves.toBe(false);
    });

    it('survives storage errors without throwing — restoreFromStorage() returns false', async () => {
      const flaky: SecureStorage = {
        isAvailable: async () => true,
        get: async () => { throw new Error('keychain offline'); },
        set: async () => {},
        remove: async () => {},
      };
      const svc = new IdentityService(fastArgon, flaky);
      await expect(svc.restoreFromStorage('user-123')).resolves.toBe(false);
      expect(svc.isUnlocked()).toBe(false);
    });
  });
});
