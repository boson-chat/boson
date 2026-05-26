import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// SecureStore persists short strings to disk under `app.getPath('userData')`
// using one of two encryption modes:
//
//   1. Preferred ("keychain"): Electron `safeStorage`, backed by the OS-level
//      keychain (macOS Keychain, Windows DPAPI, libsecret on Linux).
//
//   2. Fallback ("derived"): AES-256-GCM with a key derived from the local
//      OS user (`username + hostname + fixed salt`). Used when the keychain
//      is unavailable — typically headless Linux without a keyring daemon,
//      including WSL2 where libsecret has no backing service. Less secure
//      than the OS keychain (anyone with read access to the user's home
//      directory can derive the key), but it's not plaintext and the alt is
//      forcing re-login on every launch. Production deployments on macOS /
//      Windows always hit the keychain path; "derived" is a dev/Linux
//      convenience.
//
// File format (intentionally tiny + forwards-compatible). Each stored value
// is prefixed with a tag that identifies the encryption mode so reads can
// dispatch correctly even after a host moves between modes:
//   "ks1:<base64 of safeStorage.encryptString>"   — keychain
//   "fb1:<base64 of iv||tag||ciphertext (AES-GCM)>" — derived-key fallback
// Tag-less values (from the original v1 storage layout) are interpreted as
// keychain ciphertext for backwards compatibility.

const STORE_FILENAME = 'identity-store.json';
const TAG_KEYCHAIN = 'ks1:';
const TAG_FALLBACK = 'fb1:';
const FALLBACK_SALT = 'boson-secure-store-fallback-v1';

type Record = { [key: string]: string };

export class SecureStore {
  // Cached in-memory mirror of the on-disk JSON. `null` means "not loaded
  // yet" — we hydrate lazily on first access so the main process startup
  // doesn't block on disk I/O.
  private cache: Record | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  // Allow tests / callers to override the file path; defaults to the standard
  // Electron userData dir.
  constructor(private readonly filePath: string = defaultFilePath()) {}

  // 'keychain' = OS keychain via safeStorage (preferred).
  // 'derived'  = AES-GCM with a machine-derived key (fallback for headless
  //              Linux / WSL).
  // 'none'     = neither path works (extremely unlikely; only if Node crypto
  //              is missing — keep the check defensive).
  mode(): 'keychain' | 'derived' | 'none' {
    try {
      if (safeStorage.isEncryptionAvailable()) return 'keychain';
    } catch { /* fall through */ }
    try {
      // Smoke test: derive a key. If Node crypto is broken we have bigger
      // problems, but treat as unavailable rather than crashing on writes.
      this.deriveFallbackKey();
      return 'derived';
    } catch {
      return 'none';
    }
  }

  isAvailable(): boolean {
    return this.mode() !== 'none';
  }

  async get(key: string): Promise<string | null> {
    if (typeof key !== 'string' || key.length === 0) return null;
    const data = await this.load();
    const raw = data[key];
    if (!raw) return null;
    try {
      if (raw.startsWith(TAG_FALLBACK)) return this.decryptFallback(raw);
      if (raw.startsWith(TAG_KEYCHAIN)) return this.decryptKeychain(raw.slice(TAG_KEYCHAIN.length));
      // Untagged legacy value from the original storage layout — assume
      // keychain. If safeStorage is now unavailable (host moved), the decrypt
      // throws and we return null below.
      return this.decryptKeychain(raw);
    } catch {
      // Ciphertext from a different OS user / migrated machine / corrupted
      // file — treat as missing rather than throwing into the renderer.
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (typeof key !== 'string' || key.length === 0) return;
    if (typeof value !== 'string') return;
    const m = this.mode();
    if (m === 'none') return;
    const encrypted = m === 'keychain'
      ? TAG_KEYCHAIN + safeStorage.encryptString(value).toString('base64')
      : this.encryptFallback(value);
    const data = await this.load();
    data[key] = encrypted;
    await this.persist(data);
  }

  async remove(key: string): Promise<void> {
    if (typeof key !== 'string' || key.length === 0) return;
    const data = await this.load();
    if (!(key in data)) return;
    delete data[key];
    await this.persist(data);
  }

  // ----- crypto -----

  private decryptKeychain(b64: string): string {
    const buf = Buffer.from(b64, 'base64');
    return safeStorage.decryptString(buf);
  }

  private deriveFallbackKey(): Buffer {
    const seed = [os.userInfo().username, os.hostname(), FALLBACK_SALT].join('::');
    return crypto.createHash('sha256').update(seed).digest();
  }

  private encryptFallback(plaintext: string): string {
    const key = this.deriveFallbackKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return TAG_FALLBACK + Buffer.concat([iv, tag, ct]).toString('base64');
  }

  private decryptFallback(blob: string): string {
    const raw = Buffer.from(blob.slice(TAG_FALLBACK.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const key = this.deriveFallbackKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  // ----- internals -----

  private async load(): Promise<Record> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record = {};
        for (const [k, v] of Object.entries(parsed as { [k: string]: unknown })) {
          if (typeof v === 'string') out[k] = v;
        }
        this.cache = out;
        return this.cache;
      }
    } catch (err) {
      // ENOENT, malformed JSON, etc. — start fresh. Anything destructive on
      // first save is intentional: a broken file isn't useful.
      void err;
    }
    this.cache = {};
    return this.cache;
  }

  // Serialize concurrent writes — race-free even if two IPC calls land at
  // roughly the same time. Each `persist` chains onto the previous write.
  private persist(data: Record): Promise<void> {
    this.cache = data;
    const snapshot = JSON.stringify(data);
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => fs.writeFile(this.filePath, snapshot, { encoding: 'utf8', mode: 0o600 }));
    return this.writeQueue;
  }
}

function defaultFilePath(): string {
  return join(app.getPath('userData'), STORE_FILENAME);
}
