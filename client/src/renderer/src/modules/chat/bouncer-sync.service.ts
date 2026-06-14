import type { IdentityService } from '../identity/identity.service';
import type { BouncerSecretDTO } from '../directory/directory.types';
import type { SecureStorage } from '../../shared/secure-storage';
import { windowSecureStorage } from '../../shared/secure-storage';
import { getBouncerStore, type BouncerStore, type BouncerProfile } from './bouncer.store';

// Narrow backend surface — DirectoryService satisfies it structurally.
export interface BouncerSyncBackend {
  getBouncer(): Promise<BouncerSecretDTO | null>;
  putBouncer(ciphertextBase64: string): Promise<void>;
  deleteBouncer(): Promise<void>;
}

// Single "last synced at" timestamp (ms). Last-writer-wins: if the server's
// blob is newer than the last time THIS device synced, another device updated
// it → take it; otherwise our local copy is current → push it.
const SYNC_META_KEY = 'boson.bouncer-sync.meta';
const PUSH_DEBOUNCE_MS = 800;

// BouncerSyncService is the single-value analogue of NickservSyncService for
// the GLOBAL bouncer profile. Pull on every identity unlock; push (debounced)
// on every local change. No-ops gracefully when locked or the keychain backing
// is unavailable.
export class BouncerSyncService {
  private started = false;
  private unsubIdentity: (() => void) | null = null;
  private unsubStore: (() => void) | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  // JSON key of the last profile we synced — skips redundant PUTs and stops a
  // just-pulled value from echoing back up. null = nothing synced from here.
  private lastSynced: string | null = null;

  constructor(
    private readonly identity: IdentityService,
    private readonly backend: BouncerSyncBackend,
    private readonly store: BouncerStore = getBouncerStore(),
    private readonly secure: SecureStorage = windowSecureStorage,
    private readonly debounceMs: number = PUSH_DEBOUNCE_MS,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubIdentity = this.identity.subscribe((s) => {
      if (s.status === 'unlocked') void this.hydrateFromBackend();
    });
    // subscribe() fires immediately with the current value; onLocalChange
    // no-ops while locked, and the lastSynced guard prevents echoing a pulled
    // value, so the initial callback is harmless.
    this.unsubStore = this.store.subscribe(() => this.onLocalChange());
  }

  dispose(): void {
    this.unsubIdentity?.();
    this.unsubStore?.();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.started = false;
  }

  // ---- pull + merge ------------------------------------------------------

  async hydrateFromBackend(): Promise<void> {
    if (!this.identity.isUnlocked()) return;
    if (!(await this.backingAvailable())) return;
    await this.store.whenHydrated();

    let remote: BouncerSecretDTO | null;
    try {
      remote = await this.backend.getBouncer();
    } catch {
      return; // unreachable — keep local, retry next unlock
    }

    const meta = await this.loadMeta();
    if (!remote) {
      // Nothing server-side yet — push local profile up so other devices get it.
      const local = this.store.get();
      if (local) await this.pushNow(local, meta);
      await this.saveMeta(meta);
      return;
    }

    let profile: BouncerProfile;
    try {
      profile = await this.identity.decryptBouncerProfile(remote.ciphertext);
    } catch {
      return; // decrypt failure (wrong key / corrupt) → keep local
    }

    const remoteAt = Date.parse(remote.updated_at) || 0;
    const localAt = meta.at ?? 0;
    const local = this.store.get();
    if (!local || remoteAt >= localAt) {
      this.lastSynced = profileKey(profile); // set BEFORE store.set so the
      this.store.set(profile);               // resulting onLocalChange is a no-op
      meta.at = remoteAt;
    } else {
      await this.pushNow(local, meta);
    }
    await this.saveMeta(meta);
  }

  // ---- push (write-through) ---------------------------------------------

  private onLocalChange(): void {
    if (!this.identity.isUnlocked()) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (!this.identity.isUnlocked()) return;
    if (!(await this.backingAvailable())) return;

    const profile = this.store.get();
    if (!profile) {
      // Cleared locally → remove the remote copy (only if we'd synced one).
      if (this.lastSynced !== null) {
        try {
          await this.backend.deleteBouncer();
          this.lastSynced = null;
          await this.saveMeta({});
        } catch {
          /* retried on next change */
        }
      }
      return;
    }
    const meta = await this.loadMeta();
    await this.pushNow(profile, meta);
    await this.saveMeta(meta);
  }

  private async pushNow(profile: BouncerProfile, meta: { at?: number }): Promise<void> {
    const key = profileKey(profile);
    if (this.lastSynced === key) return; // unchanged / just-pulled
    try {
      const ciphertext = await this.identity.encryptBouncerProfile(profile);
      await this.backend.putBouncer(ciphertext);
      this.lastSynced = key;
      meta.at = Date.now();
    } catch {
      /* retried on next change */
    }
  }

  // ---- helpers -----------------------------------------------------------

  private async backingAvailable(): Promise<boolean> {
    try {
      return await this.secure.isAvailable();
    } catch {
      return false;
    }
  }

  private async loadMeta(): Promise<{ at?: number }> {
    try {
      const raw = await this.secure.get(SYNC_META_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') return parsed as { at?: number };
      }
    } catch {
      /* ignore */
    }
    return {};
  }

  private async saveMeta(meta: { at?: number }): Promise<void> {
    try {
      await this.secure.set(SYNC_META_KEY, JSON.stringify(meta));
    } catch {
      /* ignore */
    }
  }
}

function profileKey(p: BouncerProfile): string {
  return JSON.stringify([p.enabled, p.host, p.port, p.tls, p.tlsInsecure, p.username, p.password]);
}
