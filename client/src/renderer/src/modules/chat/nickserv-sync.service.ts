import type { IdentityService } from '../identity/identity.service';
import type { NickservSecretDTO } from '../directory/directory.types';
import type { SecureStorage } from '../../shared/secure-storage';
import { windowSecureStorage } from '../../shared/secure-storage';
import {
  getServiceCredentialsStore,
  type ServiceCredentials,
  type ServiceCredentialsStore,
} from './services-credentials';

// Minimal backend surface the sync service needs — DirectoryService satisfies
// it structurally. Kept narrow so tests can pass a fake.
export interface NickservSyncBackend {
  listNickservSecrets(): Promise<NickservSecretDTO[]>;
  putNickservSecret(serverId: string, ciphertextBase64: string): Promise<void>;
  deleteNickservSecret(serverId: string): Promise<void>;
}

// Persisted per-server "last synced at" timestamps (ms). Lets the merge do
// last-writer-wins: if the server's blob is newer than the last time THIS
// device synced that server, another device updated it → take it; otherwise
// our local copy is current/newer → push it.
const SYNC_META_KEY = 'boson.nickserv-sync.meta';
const PUSH_DEBOUNCE_MS = 800;

// NickservSyncService bridges the local keychain credential store, the
// IdentityService (which holds user_secret and does the E2E crypto), and the
// backend. Push: when a NickServ password changes locally while unlocked, it
// encrypts + uploads (debounced). Pull: on every identity unlock it fetches,
// decrypts, and merges the server's secrets into the local store. Every path
// no-ops gracefully when locked or the keychain backing is unavailable.
export class NickservSyncService {
  private started = false;
  private unsubIdentity: (() => void) | null = null;
  private unsubStore: (() => void) | null = null;
  private readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // serverId → JSON key of the last password/account we synced, so we skip
  // redundant PUTs and don't echo a just-pulled value back up.
  private readonly lastSynced = new Map<string, string>();

  constructor(
    private readonly identity: IdentityService,
    private readonly backend: NickservSyncBackend,
    private readonly store: ServiceCredentialsStore = getServiceCredentialsStore(),
    private readonly secure: SecureStorage = windowSecureStorage,
    private readonly debounceMs: number = PUSH_DEBOUNCE_MS,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    // Pull on every unlock — login, keychain auto-restore, or recovery-code.
    this.unsubIdentity = this.identity.subscribe((s) => {
      if (s.status === 'unlocked') void this.hydrateFromBackend();
    });
    // Push on every credential change. subscribeAll is optional on the store
    // interface; without it (e.g. the legacy localStorage store in tests)
    // write-through is simply disabled.
    if (this.store.subscribeAll) {
      this.unsubStore = this.store.subscribeAll((serverId) => this.onLocalChange(serverId));
    }
  }

  dispose(): void {
    this.unsubIdentity?.();
    this.unsubStore?.();
    for (const t of this.pushTimers.values()) clearTimeout(t);
    this.pushTimers.clear();
    this.started = false;
  }

  // ---- pull + merge ------------------------------------------------------

  async hydrateFromBackend(): Promise<void> {
    if (!this.identity.isUnlocked()) return;
    if (!(await this.backingAvailable())) return;
    await this.store.whenHydrated?.();

    let remote: NickservSecretDTO[];
    try {
      remote = await this.backend.listNickservSecrets();
    } catch {
      return; // backend unreachable — keep local, try again next unlock
    }

    const meta = await this.loadMeta();
    const remoteServers = new Set<string>();

    for (const r of remote) {
      remoteServers.add(r.server_id);
      let creds;
      try {
        creds = await this.identity.decryptCredsForServer(r.server_id, r.ciphertext);
      } catch {
        continue; // decrypt failure (wrong key / corrupt) → skip, keep local
      }
      const existing = this.store.get(r.server_id) ?? {};
      const remoteAt = Date.parse(r.updated_at) || 0;
      const localAt = meta[r.server_id] ?? 0;
      const localHasPassword = Boolean(existing.nickservPassword);
      // Take remote on a fresh device (no local password) or when it's newer
      // than our last sync of this server.
      if (!localHasPassword || remoteAt >= localAt) {
        const accountName = creds.accountName ?? existing.accountName;
        this.store.set(r.server_id, {
          ...existing,
          nickservPassword: creds.nickservPassword,
          accountName,
        });
        meta[r.server_id] = remoteAt;
        this.lastSynced.set(r.server_id, credKey(creds.nickservPassword, accountName));
      } else {
        // Local is newer than the server's copy → push local up so the other
        // devices converge on it.
        await this.pushNow(r.server_id, existing, meta);
      }
    }

    // Push local-only servers (have a password, not on the server yet).
    for (const [serverId, creds] of this.localEntries()) {
      if (remoteServers.has(serverId) || !creds.nickservPassword) continue;
      await this.pushNow(serverId, creds, meta);
    }

    await this.saveMeta(meta);
  }

  // ---- push (write-through) ---------------------------------------------

  private onLocalChange(serverId: string): void {
    if (!this.identity.isUnlocked()) return;
    // Debounce: a claim flow fires many store.set()s with intermediate state;
    // coalesce to the terminal value per server.
    const existing = this.pushTimers.get(serverId);
    if (existing) clearTimeout(existing);
    this.pushTimers.set(
      serverId,
      setTimeout(() => {
        this.pushTimers.delete(serverId);
        void this.flushServer(serverId);
      }, this.debounceMs),
    );
  }

  private async flushServer(serverId: string): Promise<void> {
    if (!this.identity.isUnlocked()) return;
    if (!(await this.backingAvailable())) return;

    const creds = this.store.get(serverId);
    if (!creds?.nickservPassword) {
      // Password cleared/dropped locally → remove the remote copy (only if we
      // had synced one, to avoid pointless 404 churn).
      if (this.lastSynced.has(serverId)) {
        try {
          await this.backend.deleteNickservSecret(serverId);
          this.lastSynced.delete(serverId);
          const meta = await this.loadMeta();
          delete meta[serverId];
          await this.saveMeta(meta);
        } catch {
          /* retried on next change */
        }
      }
      return;
    }

    const meta = await this.loadMeta();
    await this.pushNow(serverId, creds, meta);
    await this.saveMeta(meta);
  }

  private async pushNow(
    serverId: string,
    creds: ServiceCredentials,
    meta: Record<string, number>,
  ): Promise<void> {
    if (!creds.nickservPassword) return;
    const key = credKey(creds.nickservPassword, creds.accountName);
    if (this.lastSynced.get(serverId) === key) return; // unchanged / just-pulled
    try {
      const ciphertext = await this.identity.encryptCredsForServer(serverId, {
        nickservPassword: creds.nickservPassword,
        accountName: creds.accountName,
      });
      await this.backend.putNickservSecret(serverId, ciphertext);
      this.lastSynced.set(serverId, key);
      meta[serverId] = Date.now();
    } catch {
      /* retried on next change */
    }
  }

  // ---- helpers -----------------------------------------------------------

  private localEntries(): Array<[string, ServiceCredentials]> {
    return this.store.entries ? this.store.entries() : [];
  }

  private async backingAvailable(): Promise<boolean> {
    try {
      return await this.secure.isAvailable();
    } catch {
      return false;
    }
  }

  private async loadMeta(): Promise<Record<string, number>> {
    try {
      const raw = await this.secure.get(SYNC_META_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') return parsed as Record<string, number>;
      }
    } catch {
      /* ignore */
    }
    return {};
  }

  private async saveMeta(meta: Record<string, number>): Promise<void> {
    try {
      await this.secure.set(SYNC_META_KEY, JSON.stringify(meta));
    } catch {
      /* ignore */
    }
  }
}

function credKey(password: string | undefined, accountName: string | undefined): string {
  return JSON.stringify({ p: password ?? '', a: accountName ?? '' });
}
