import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createWebSecureStore, storesKeysAsBytes } from './secure-store';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle as unknown as SubtleCrypto;

describe('web secure store', () => {
  for (const rawKey of [false, true]) {
    it(`round-trips, overwrites and removes values (raw key: ${rawKey})`, async () => {
      const idb = new IDBFactory();
      const s = createWebSecureStore(idb, subtle, rawKey);
      expect(await s.isAvailable()).toBe(true);
      expect(await s.get('a')).toBeNull();
      await s.set('a', 'secret ✓');
      expect(await s.get('a')).toBe('secret ✓');
      await s.set('a', 'second');
      expect(await s.get('a')).toBe('second');
      // A second store on the same database (another tab, a reload) reads it.
      expect(await createWebSecureStore(idb, subtle, rawKey).get('a')).toBe('second');
      await s.remove('a');
      expect(await s.get('a')).toBeNull();
    });
  }

  it('stores ciphertext, not the value', async () => {
    const idb = new IDBFactory();
    const s = createWebSecureStore(idb, subtle, false);
    await s.set('token', 'plain-value');
    const raw = await new Promise<unknown>((resolve) => {
      const r = idb.open('boson-secure', 1);
      r.onsuccess = () => {
        const g = r.result.transaction('kv').objectStore('kv').get('v:token');
        g.onsuccess = () => resolve(g.result);
      };
    });
    expect(String(raw)).toMatch(/^wb1:/);
    expect(String(raw)).not.toContain('plain-value');
  });

  it('treats a value it cannot decrypt as missing', async () => {
    const idb = new IDBFactory();
    const s = createWebSecureStore(idb, subtle, true);
    await s.set('k', 'v');
    // A different key (storage partly cleared): same database, new key.
    await new Promise<void>((resolve) => {
      const r = idb.open('boson-secure', 1);
      r.onsuccess = () => {
        const d = r.result.transaction('kv', 'readwrite').objectStore('kv').put(webcrypto.getRandomValues(new Uint8Array(32)), '\u0000key');
        d.onsuccess = () => resolve();
      };
    });
    expect(await createWebSecureStore(idb, subtle, true).get('k')).toBeNull();
  });

  it('keeps raw key bytes only on WebKit', () => {
    expect(storesKeysAsBytes('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15')).toBe(true);
    expect(storesKeysAsBytes('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36')).toBe(false);
    expect(storesKeysAsBytes('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0')).toBe(false);
  });
});
