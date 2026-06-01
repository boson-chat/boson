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

// Lifecycle state we know about the user's NickServ account on this
// server. Drives the Services panel's status badge + which actions
// are surfaced.
//
//   unknown               — nothing saved, no observed reply yet.
//                           UI shows "Not connected to account yet"
//                           and offers Register / Identify.
//   no-account            — explicit "user has not registered" state
//                           (after a failed IDENTIFY against an
//                           unknown nick on a network where the
//                           daemon reports that distinctly).
//   pending-confirmation  — REGISTER fired, NickServ replied with a
//                           "verify your email" prompt. Status sticks
//                           until we observe a confirmation reply or
//                           the user clicks Cancel.
//   identified            — most recent IDENTIFY (auto or manual)
//                           succeeded for this connection.
//   identify-failed       — last IDENTIFY rejected (wrong password,
//                           account doesn't exist, etc.). Distinct
//                           from no-account so the UI can warn
//                           without nuking the saved password.
//   registered            — credentials saved + we believe an account
//                           exists, but we haven't seen the post-
//                           welcome IDENTIFY land yet this session.
//                           Default load state when nickservPassword
//                           is set but status was never persisted.
export type AccountStatus =
  | 'unknown'
  | 'no-account'
  // Transient — we fired REGISTER and are waiting on NickServ. The
  // panel shows a "registering..." line until the classifier writes
  // a real terminal status (pending-confirmation, registered,
  // identified, or identify-failed).
  | 'registering'
  | 'pending-confirmation'
  | 'identified'
  // Identified-and-logged-in BUT the account itself hasn't been
  // email-confirmed yet (Anope: "is an unconfirmed nickname" / "Your
  // email address is not confirmed" / "will expire, if not
  // confirmed"; Atheme: MU_WAITAUTH flag → "NOT COMPLETED
  // registration verification"). The user can use the account, but
  // it expires (typically ~24h) if confirmation isn't completed.
  // UI surfaces the confirm-code input so they can paste the code
  // from email.
  | 'identified-unconfirmed'
  | 'identify-failed'
  | 'registered';

// Pending-registration bookkeeping for the automated flow. When the
// user clicks Register while signed in, the client calls the backend
// to mint a `reg+<token>@boson.chat` address; that token is persisted
// here so a reload mid-registration can resume the poll instead of
// dropping the user back to a blank form.
export interface PendingRegistration {
  token: string;
  email: string;
}

export interface ServiceCredentials {
  // NickServ IDENTIFY password. When present, the chat service auto-sends
  // `/msg NickServ IDENTIFY <password>` after RPL_WELCOME (001).
  nickservPassword?: string;
  // Account nick the credentials are for. Defaults to the current
  // session's nick when omitted (older entries from before this
  // field existed have no value here).
  accountName?: string;
  // Email used at REGISTER time. For the manual flow this is the
  // user's real email; for the automated flow it's the
  // reg+<token>@boson.chat address. Persisted so the panel can show
  // "We sent the code to ..." after a reload.
  email?: string;
  // Last-known account state. Persisted so the badge reads correctly
  // before any server reply has landed on a fresh page load.
  status?: AccountStatus;
  // True when `nickservPassword` was minted by the client (crypto-
  // random) rather than typed by the user. Drives the Services panel
  // to hide the password input behind a reveal affordance instead of
  // showing it as a free-form field.
  generatedPassword?: boolean;
  // Set while an automated registration is in-flight — the token +
  // email the backend handed us. Cleared on success / expiry /
  // cancel.
  pendingRegistration?: PendingRegistration;
  // Epoch ms timestamp after which the Resend button becomes
  // clickable again. Written by ChatService when NickServ replies
  // with the cooldown phrasing ("Cannot send mail now; please
  // retry a little later"). Anope's `resenddelay` default is in
  // the 5-min range; the reply itself carries no precise time so
  // we pin it to 5 min from when we see the reply.
  resendCooldownUntil?: number;
}

export type ServiceCredentialsListener = (creds: ServiceCredentials | null) => void;

export interface ServiceCredentialsStore {
  get(serverId: string): ServiceCredentials | null;
  set(serverId: string, creds: ServiceCredentials): void;
  clear(serverId: string): void;
  // Subscribe to per-server changes. The listener is invoked synch-
  // ronously on every mutation that hits the given serverId; the
  // initial fire delivers the current value (or null) so consumers
  // don't have to special-case mount time. Returns an unsubscribe.
  subscribe(serverId: string, fn: ServiceCredentialsListener): () => void;
}

const STORAGE_PREFIX = 'boson.services-creds.';

// localStorage-backed implementation. Single-process by definition (each
// renderer's localStorage is isolated), so concurrent writes aren't a
// concern. Read-modify-write is fine.
export class LocalStorageServiceCredentialsStore implements ServiceCredentialsStore {
  // Listener fan-out is per-serverId — a Services panel for server A
  // shouldn't re-render when the user updates server B. Map keyed by
  // serverId; each entry holds the active listener set.
  private readonly listeners = new Map<string, Set<ServiceCredentialsListener>>();

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
    // Reject objects whose every value is unset — equivalent to clear().
    // We check field-by-field because nested PendingRegistration is an
    // object whose presence (not value) is meaningful.
    const hasContent =
      Boolean(creds.nickservPassword)
      || Boolean(creds.accountName)
      || Boolean(creds.email)
      || Boolean(creds.status)
      || Boolean(creds.generatedPassword)
      || Boolean(creds.pendingRegistration);
    if (!hasContent) {
      this.clear(serverId);
      return;
    }
    this.storage.setItem(STORAGE_PREFIX + serverId, JSON.stringify(creds));
    this.emit(serverId, creds);
  }

  clear(serverId: string): void {
    this.storage.removeItem(STORAGE_PREFIX + serverId);
    this.emit(serverId, null);
  }

  subscribe(serverId: string, fn: ServiceCredentialsListener): () => void {
    let set = this.listeners.get(serverId);
    if (!set) {
      set = new Set();
      this.listeners.set(serverId, set);
    }
    set.add(fn);
    // Synchronous initial fire — same buffered-then-drained pattern
    // MemoStore + the engine's services-framework subscribe use.
    // Isolate exceptions so a bad subscriber can't crash the caller.
    try { fn(this.get(serverId)); } catch { /* isolate */ }
    return () => {
      const s = this.listeners.get(serverId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.listeners.delete(serverId);
    };
  }

  private emit(serverId: string, value: ServiceCredentials | null): void {
    const set = this.listeners.get(serverId);
    if (!set) return;
    for (const fn of set) {
      try { fn(value); } catch { /* isolate */ }
    }
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
