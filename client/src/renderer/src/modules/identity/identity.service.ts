import type { SecureStorage } from '../../shared/secure-storage';
import { windowSecureStorage } from '../../shared/secure-storage';
import type { ArgonFn } from './crypto';
import type { IdentityState } from './identity.types';
import {
  base64Decode,
  base64Encode,
  decryptUserSecret,
  deriveSaslPassword,
  encryptUserSecret,
  generateUserSecret,
  zeroize,
} from './crypto';

export type IdentityListener = (s: IdentityState) => void;

// Namespaced storage key so multiple Supabase accounts on one machine can
// each have their own persisted secret without colliding.
const STORAGE_KEY_PREFIX = 'boson.identity.';
function storageKey(userId: string): string { return `${STORAGE_KEY_PREFIX}${userId}`; }

/**
 * IdentityService manages the user's 32-byte `user_secret` lifecycle:
 *   - signup:  generate fresh secret, encrypt with KEK(password), expose base64 for POST /me
 *   - signin:  decrypt server-side blob with KEK(password); cache plaintext in memory
 *   - per-server SASL: HMAC-SHA256(user_secret, "irc-password" || server_id)
 *
 * Plaintext user_secret never leaves this instance. KEK is also never stored —
 * it's re-derived from the password whenever needed, and the password isn't
 * retained either (caller passes it for unlock then can drop it).
 *
 * The OS keychain (via `SecureStorage`) holds the unlocked `user_secret`
 * itself (base64-encoded, then encrypted by `safeStorage`) so a returning user
 * doesn't have to type their password every launch. Locking is in-memory only;
 * sign-out is what clears the keychain entry.
 */
export class IdentityService {
  private userSecret: Uint8Array | null = null;
  // Held in memory only on first signup, until the caller uses it for POST /me.
  // Cleared in `clearPendingEncrypted()` to avoid lingering ciphertext.
  private pendingEncryptedB64: string | null = null;
  private state: IdentityState = { status: 'locked' };
  private readonly listeners = new Set<IdentityListener>();
  private readonly secureStorage: SecureStorage;

  // Injectable so tests can use a no-op / fast KDF rather than real Argon2id
  // (which takes ~200ms per call). Production always uses the default.
  // `secureStorage` defaults to the window-bridge implementation; tests pass
  // an in-memory stub.
  constructor(
    private readonly argonOverride?: ArgonFn,
    secureStorage?: SecureStorage,
  ) {
    this.secureStorage = secureStorage ?? windowSecureStorage;
  }

  getState(): IdentityState { return this.state; }

  isUnlocked(): boolean { return this.state.status === 'unlocked' && this.userSecret !== null; }

  subscribe(fn: IdentityListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * First-time signup path: generate user_secret, encrypt with KEK(password),
   * cache plaintext locally, hand back the base64 ciphertext for POST /me.
   */
  async initializeForNewUser(password: string): Promise<string> {
    this.disposeSecret();
    const secret = generateUserSecret();
    const blob = await encryptUserSecret(secret, password, this.argonOverride);
    this.userSecret = secret;
    this.pendingEncryptedB64 = base64Encode(blob);
    this.setState({ status: 'unlocked' });
    return this.pendingEncryptedB64;
  }

  /** Returns the most recently generated encrypted blob (base64), or null. */
  getPendingEncrypted(): string | null { return this.pendingEncryptedB64; }
  clearPendingEncrypted(): void { this.pendingEncryptedB64 = null; }

  /**
   * Existing-user signin path: try to decrypt the stored blob with KEK(password).
   * Throws on any failure (wrong password, malformed blob, etc.). The service
   * remains locked after a failed attempt.
   */
  async unlock(password: string, encryptedB64: string): Promise<void> {
    try {
      const blob = base64Decode(encryptedB64);
      const secret = await decryptUserSecret(blob, password, this.argonOverride);
      this.disposeSecret();
      this.userSecret = secret;
      this.setState({ status: 'unlocked' });
    } catch (err) {
      this.setState({
        status: 'locked',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Drop in-memory key material. Call on sign-out and on tab close.
   * Does NOT clear keychain-persisted material — that's `clearStorage()`'s
   * job, scoped to the explicit sign-out flow.
   */
  lock(): void {
    this.disposeSecret();
    this.pendingEncryptedB64 = null;
    this.setState({ status: 'locked' });
  }

  /**
   * Persist the unlocked user_secret to the OS keychain so subsequent launches
   * can call `restoreFromStorage()` without prompting for a password. Returns
   * true on success, false when locked OR when the keychain backend isn't
   * available (e.g. headless Linux). Never throws — persistence is best-effort.
   */
  async persist(userId: string): Promise<boolean> {
    if (!userId) return false;
    if (!this.userSecret || this.state.status !== 'unlocked') return false;
    try {
      if (!(await this.secureStorage.isAvailable())) return false;
      const b64 = base64Encode(this.userSecret);
      await this.secureStorage.set(storageKey(userId), b64);
      return true;
    } catch (err) {
      // Persistence is opportunistic; log loudly but don't break sign-in.
      // eslint-disable-next-line no-console
      console.warn('[identity.persist] failed:', err);
      return false;
    }
  }

  /**
   * Hydrate the in-memory user_secret from the OS keychain, transitioning the
   * service to unlocked. Returns true if a stored value was found and applied,
   * false otherwise. Stays locked on any error.
   */
  async restoreFromStorage(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
      if (!(await this.secureStorage.isAvailable())) return false;
      const b64 = await this.secureStorage.get(storageKey(userId));
      if (!b64) return false;
      const secret = base64Decode(b64);
      if (secret.byteLength !== 32) return false;
      this.disposeSecret();
      this.userSecret = secret;
      this.setState({ status: 'unlocked' });
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[identity.restoreFromStorage] failed:', err);
      return false;
    }
  }

  /**
   * Remove the keychain-persisted user_secret for the given account. Call
   * this from the sign-out path BEFORE the auth signOut so a follow-up
   * launch starts cleanly.
   */
  async clearStorage(userId: string): Promise<void> {
    if (!userId) return;
    try {
      await this.secureStorage.remove(storageKey(userId));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[identity.clearStorage] failed:', err);
    }
  }

  /**
   * HMAC-SHA256(user_secret, "irc-password" || server_id), URL-safe base64.
   * Throws if locked — the caller is responsible for prompting unlock first.
   */
  async saslPasswordForServer(serverId: string): Promise<string> {
    if (!this.userSecret) {
      throw new Error('identity: locked — cannot derive SASL password');
    }
    return deriveSaslPassword(this.userSecret, serverId);
  }

  private disposeSecret(): void {
    if (this.userSecret) zeroize(this.userSecret);
    this.userSecret = null;
  }

  private setState(next: IdentityState): void {
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
  }
}
