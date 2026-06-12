import type { SecureStorage } from '../../shared/secure-storage';
import { windowSecureStorage } from '../../shared/secure-storage';
import type { ArgonFn } from './crypto';
import type { IdentityState } from './identity.types';
import {
  base64Decode,
  base64Encode,
  decryptUserSecret,
  decryptCreds,
  deriveSaslPassword,
  encryptUserSecret,
  encryptCreds,
  generateRecoveryCode,
  generateUserSecret,
  unwrapUserSecret,
  wrapUserSecret,
  zeroize,
  type NickservCreds,
} from './crypto';

// One-time recovery material surfaced after signup: the wrap to persist
// server-side plus the human-readable code to show the user exactly once.
export interface PendingRecovery {
  recoveryBlob: string; // base64, → users.encrypted_user_secret_recovery
  recoveryCode: string; // shown once, never persisted by us
}

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
  // Recovery wrap + one-time code generated alongside the password wrap at
  // signup. Surfaced via getPendingRecovery() so the SetupPrompt can POST the
  // wrap and show the code once. Cleared together with pendingEncryptedB64.
  private pendingRecovery: PendingRecovery | null = null;
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
    // Generate the recovery wrap alongside the password wrap so signup can
    // store both and show the code once. Independent salt ⇒ independent KEK.
    const recoveryCode = generateRecoveryCode();
    const recoveryBlob = await wrapUserSecret(secret, recoveryCode, this.argonOverride);
    this.userSecret = secret;
    this.pendingEncryptedB64 = base64Encode(blob);
    this.pendingRecovery = { recoveryBlob: base64Encode(recoveryBlob), recoveryCode };
    this.setState({ status: 'unlocked' });
    return this.pendingEncryptedB64;
  }

  /** Returns the most recently generated encrypted blob (base64), or null. */
  getPendingEncrypted(): string | null { return this.pendingEncryptedB64; }
  /** Recovery wrap + one-time code generated at signup (or null). */
  getPendingRecovery(): PendingRecovery | null { return this.pendingRecovery; }
  clearPendingEncrypted(): void {
    this.pendingEncryptedB64 = null;
    this.pendingRecovery = null;
  }

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
    this.pendingRecovery = null;
    this.setState({ status: 'locked' });
  }

  /**
   * Recovery path: decrypt the server-stored recovery wrap with the user's
   * one-time recovery code. Used when they've forgotten their login password
   * (a Supabase reset leaves the password wrap stale). On success the service
   * is unlocked but the password wrap is now out of date — the caller should
   * follow up with rewrapForNewPassword + persist the new wrap.
   * Throws (and stays locked) on a wrong/garbled code.
   */
  async unlockWithRecoveryCode(recoveryCode: string, recoveryB64: string): Promise<void> {
    try {
      const blob = base64Decode(recoveryB64);
      const secret = await unwrapUserSecret(blob, recoveryCode, this.argonOverride);
      this.disposeSecret();
      this.userSecret = secret;
      this.setState({ status: 'unlocked' });
    } catch (err) {
      this.setState({ status: 'locked', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /**
   * Generate a fresh recovery code for an already-unlocked user and return the
   * wrap to persist + the code to show once. Used to enroll a recovery code
   * for existing accounts (created before recovery wraps existed) or to
   * regenerate one. Throws if locked.
   */
  async enrollRecoveryCode(): Promise<PendingRecovery> {
    if (!this.userSecret || this.state.status !== 'unlocked') {
      throw new Error('identity: locked — cannot enroll a recovery code');
    }
    const recoveryCode = generateRecoveryCode();
    const recoveryBlob = await wrapUserSecret(this.userSecret, recoveryCode, this.argonOverride);
    return { recoveryBlob: base64Encode(recoveryBlob), recoveryCode };
  }

  /**
   * Re-wrap the in-memory user_secret under a new password and return the new
   * password-wrap (base64) to persist via PUT /me/secret-wraps. Used after a
   * recovery-code unlock (password reset) so the password wrap matches the new
   * login password. The recovery wrap is unaffected. Throws if locked.
   */
  async rewrapForNewPassword(newPassword: string): Promise<string> {
    if (!this.userSecret || this.state.status !== 'unlocked') {
      throw new Error('identity: locked — cannot re-wrap');
    }
    const blob = await encryptUserSecret(this.userSecret, newPassword, this.argonOverride);
    return base64Encode(blob);
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

  // Encrypt/decrypt a server's NickServ creds for E2E sync. Kept here so the
  // plaintext user_secret never leaves the service. Throws if locked.
  async encryptCredsForServer(serverId: string, creds: NickservCreds): Promise<string> {
    if (!this.userSecret) throw new Error('identity: locked — cannot encrypt creds');
    return encryptCreds(this.userSecret, serverId, creds);
  }

  async decryptCredsForServer(serverId: string, blobB64: string): Promise<NickservCreds> {
    if (!this.userSecret) throw new Error('identity: locked — cannot decrypt creds');
    return decryptCreds(this.userSecret, serverId, blobB64);
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
