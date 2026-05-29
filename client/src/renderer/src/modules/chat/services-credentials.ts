// Per-server credentials for IRC services (NickServ, ChanServ, etc.). Stored
// in localStorage as plain JSON, keyed by `serverId`. The user has signed off
// on plain-text storage (no OS-keychain wrapping) because:
//   - This is a local-only file that doesn't leave the device.
//   - The services password is already exchanged in plaintext over IRC for
//     legacy NickServ IDENTIFY anyway (modern flows use SASL).
//   - Adding the keychain dance was a UX-vs-security trade we deferred.
//
// If we ever want to upgrade, swap the `LocalStorageServiceCredentialsStore`
// implementation for one backed by the main process's `SecureStore`.

export interface ServiceCredentials {
  // NickServ IDENTIFY password. When present, the chat service auto-sends
  // `/msg NickServ IDENTIFY <password>` after RPL_WELCOME (001).
  nickservPassword?: string;
}

export interface ServiceCredentialsStore {
  get(serverId: string): ServiceCredentials | null;
  set(serverId: string, creds: ServiceCredentials): void;
  clear(serverId: string): void;
}

const STORAGE_PREFIX = 'boson.services-creds.';

// localStorage-backed implementation. Single-process by definition (each
// renderer's localStorage is isolated), so concurrent writes aren't a
// concern. Read-modify-write is fine.
export class LocalStorageServiceCredentialsStore implements ServiceCredentialsStore {
  constructor(private readonly storage: Storage = localStorage) {}

  get(serverId: string): ServiceCredentials | null {
    const raw = this.storage.getItem(STORAGE_PREFIX + serverId);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ServiceCredentials;
      if (typeof parsed !== 'object' || parsed === null) return null;
      return parsed;
    } catch {
      // Corrupt entry — drop it so subsequent reads return null cleanly.
      this.storage.removeItem(STORAGE_PREFIX + serverId);
      return null;
    }
  }

  set(serverId: string, creds: ServiceCredentials): void {
    // Reject empty objects to keep the store tidy — equivalent to clear().
    const hasContent = Object.values(creds).some((v) => v !== undefined && v !== '');
    if (!hasContent) {
      this.clear(serverId);
      return;
    }
    this.storage.setItem(STORAGE_PREFIX + serverId, JSON.stringify(creds));
  }

  clear(serverId: string): void {
    this.storage.removeItem(STORAGE_PREFIX + serverId);
  }
}

// Module-level singleton. The chat service grabs this on construction so
// callers don't have to thread it through every layer; tests can shadow
// it via `setServiceCredentialsStore`.
let store: ServiceCredentialsStore = new LocalStorageServiceCredentialsStore();

export function getServiceCredentialsStore(): ServiceCredentialsStore {
  return store;
}

export function setServiceCredentialsStore(next: ServiceCredentialsStore): void {
  store = next;
}
