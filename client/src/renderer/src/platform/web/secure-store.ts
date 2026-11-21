// window.bosonSecure in the browser: values encrypted with AES-GCM under a
// non-extractable WebCrypto key, both kept in IndexedDB. The key can't be
// read out of the browser (only used by this origin's script), so a copy of
// the profile's storage doesn't reveal the secrets; script running on the
// origin still could use it, which is what the page's CSP is for.
//
// WebKit (Safari) is the exception: it stores a CryptoKey in IndexedDB by
// wrapping it with a master key from the macOS keychain, which blocks the
// page (indefinitely in automation, and with a keychain prompt in some
// setups). There the AES key is kept as raw bytes instead, so its secrets
// are only as safe as the browser profile itself.

const DB = 'boson-secure';
const STORE = 'kv';
const KEY_ID = '\u0000key';
const PREFIX = 'wb1:';

export interface SecureBridge {
  isAvailable(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  const r = idb.open(DB, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
  return req(r);
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Safari / WebKit, not Chromium-based browsers (whose UA also says AppleWebKit).
export function storesKeysAsBytes(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(ua);
}

export function createWebSecureStore(
  idb: IDBFactory = indexedDB,
  subtle: SubtleCrypto = crypto.subtle,
  rawKey: boolean = storesKeysAsBytes(),
): SecureBridge {
  let db: Promise<IDBDatabase> | null = null;
  let key: Promise<CryptoKey> | null = null;
  const database = (): Promise<IDBDatabase> => (db ??= openDb(idb));

  const tx = async (mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await database()).transaction(STORE, mode).objectStore(STORE);

  const imported = async (stored: unknown): Promise<CryptoKey | null> => {
    if (!stored) return null;
    if (stored instanceof Uint8Array || stored instanceof ArrayBuffer) {
      return subtle.importKey('raw', stored as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    return rawKey ? null : (stored as CryptoKey);
  };

  const getKey = (): Promise<CryptoKey> => (key ??= (async () => {
    const existing = await imported(await req((await tx('readonly')).get(KEY_ID)));
    if (existing) return existing;
    let k: CryptoKey;
    let toStore: CryptoKey | Uint8Array;
    if (rawKey) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      k = await subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
      toStore = bytes;
    } else {
      k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      toStore = k;
    }
    // Another tab may have made one meanwhile: keep the first.
    const store = await tx('readwrite');
    const again = await imported(await req(store.get(KEY_ID)));
    if (again) return again;
    await req(store.put(toStore, KEY_ID));
    return k;
  })().catch((err) => { key = null; throw err; }));

  // The same argument checks as the desktop's store (desktop/securestore.go).
  const checkKey = (name: unknown): void => {
    if (typeof name !== 'string' || name === '') throw new Error('secure store requires a non-empty string key');
  };

  return {
    async isAvailable() {
      try {
        await getKey();
        return true;
      } catch {
        return false;
      }
    },
    async get(name) {
      checkKey(name);
      const raw = await req((await tx('readonly')).get(`v:${name}`)) as string | undefined;
      if (typeof raw !== 'string' || !raw.startsWith(PREFIX)) return null;
      const [ivB64, ctB64] = raw.slice(PREFIX.length).split('.');
      if (!ivB64 || !ctB64) return null;
      try {
        const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) as BufferSource }, await getKey(), unb64(ctB64) as BufferSource);
        return new TextDecoder().decode(pt);
      } catch {
        // Written under a key that's gone (storage partly cleared).
        return null;
      }
    },
    async set(name, value) {
      checkKey(name);
      if (typeof value !== 'string') throw new Error('secure store set requires a string value');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), new TextEncoder().encode(value)));
      await req((await tx('readwrite')).put(`${PREFIX}${b64(iv)}.${b64(ct)}`, `v:${name}`));
    },
    async remove(name) {
      checkKey(name);
      await req((await tx('readwrite')).delete(`v:${name}`));
    },
  };
}
