// Per-server credentials for IRC services (NickServ, ChanServ, etc.), keyed
// by `serverId`. Default storage is the OS-keychain-backed SecureStore
// (`SecureServiceCredentialsStore`) — generated claim passwords + saved
// IDENTIFY passwords no longer sit in plain-text on disk. A
// `LocalStorageServiceCredentialsStore` remains for tests and as the legacy
// format that SecureServiceCredentialsStore transparently migrates from
// (and scrubs) on first run.

import type { SecureStorage } from '../../shared/secure-storage';
import { windowSecureStorage } from '../../shared/secure-storage';

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
// user clicks Claim Nick while signed in, the client calls the
// backend to mint a `reg-<userid>-<short>@boson.chat` address; the
// returned record id is persisted here so a reload mid-flow can
// resume the poll instead of dropping the user back to a blank form.
export interface PendingRegistration {
  // Backend's `nick_claims.id` — the polling key for
  // GET /me/nick-claims/{id}.
  id: string;
  // Recipient address embedded in REGISTER. Echoed back for UI
  // display ("we sent the code to reg-…@boson.chat") and so a
  // reload can show what's pending without another backend round-
  // trip.
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
  // Resolves once the store's durable backing has finished loading
  // into the in-memory cache. Synchronous stores (localStorage) omit
  // it (reads are always current); async-backed stores (SecureStore)
  // implement it so callers that read at a timing-critical moment —
  // e.g. populating ConnectParams.nickservPassword on connect — can
  // wait for the cache to warm before reading. `await store.whenHydrated?.()`
  // is a no-op on stores that don't provide it.
  whenHydrated?(): Promise<void>;
  // Subscribe to ALL per-server mutations (not scoped to one serverId). Used
  // by the backend sync layer to push changes up as they happen. Optional —
  // only the secure store implements it.
  subscribeAll?(fn: (serverId: string, creds: ServiceCredentials | null) => void): () => void;
  // Snapshot of every server's current creds — used by the sync layer to push
  // local-only entries up on hydrate. Optional.
  entries?(): Array<[string, ServiceCredentials]>;
}

const STORAGE_PREFIX = 'boson.services-creds.';

// A ServiceCredentials object is "empty" (equivalent to no entry) when
// every meaningful field is unset. Checked field-by-field because the
// nested PendingRegistration is an object whose *presence*, not value,
// is meaningful. Shared by both store impls so the empty-means-clear
// semantics stay identical.
function credsHaveContent(creds: ServiceCredentials): boolean {
  return (
    Boolean(creds.nickservPassword)
    || Boolean(creds.accountName)
    || Boolean(creds.email)
    || Boolean(creds.status)
    || Boolean(creds.generatedPassword)
    || Boolean(creds.pendingRegistration)
  );
}

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
    // Empty object is equivalent to clear().
    if (!credsHaveContent(creds)) {
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

// Single key under which the secure store persists the whole per-server
// credentials map (`{ [serverId]: ServiceCredentials }`). One key keeps
// hydration to a single read and lets writes serialize a single snapshot.
const SECURE_KEY = 'boson.services-creds.v1';

// Diagnostic logging for the secure-store hydration + legacy migration.
// Tagged so it's greppable in the renderer DevTools console.
function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.info(`[services-creds] ${msg}`);
}

// SecureServiceCredentialsStore keeps the same synchronous read/subscribe
// API (a lot of callers — auto-identify-on-connect, the Services panel
// render — read it synchronously) but persists to the OS-keychain-backed
// SecureStorage instead of plain-text localStorage.
//
// Shape: an in-memory cache is the live source of truth for the session;
// every mutation updates the cache + notifies subscribers synchronously,
// then write-through to SecureStorage happens async on a serialized chain.
// On construction we hydrate the cache from SecureStorage (one read) and,
// the first time, migrate any legacy plain-text localStorage entries in —
// scrubbing them from disk afterwards. Callers that read at a timing-
// critical moment await `whenHydrated()` first.
export class SecureServiceCredentialsStore implements ServiceCredentialsStore {
  private readonly cache = new Map<string, ServiceCredentials>();
  private readonly listeners = new Map<string, Set<ServiceCredentialsListener>>();
  // Global (all-server) listeners — fed every mutation with its serverId.
  private readonly globalListeners = new Set<(serverId: string, creds: ServiceCredentials | null) => void>();
  private readonly hydrating: Promise<void>;
  // Serializes writes AND chains them after hydration so we never persist
  // a partial cache over the stored map before it has loaded.
  private writeChain: Promise<void>;

  // How long to keep probing for the secure backing before giving up. The
  // store constructs at module import, which can land BEFORE the preload
  // bridge (`window.bosonSecure`) is injected — so a single isAvailable()
  // check would spuriously read false and skip migration forever. We poll
  // briefly to ride out that injection lag. Tests with a definitively-
  // unavailable backing pass a tiny timeout to stay fast.
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;

  constructor(
    private readonly secure: SecureStorage,
    // Legacy plain-text store to migrate from (defaults to localStorage).
    // Pass a memory Storage in tests, or null to skip migration entirely.
    private readonly legacy: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null,
    opts: { probeIntervalMs?: number; probeTimeoutMs?: number } = {},
  ) {
    this.probeIntervalMs = opts.probeIntervalMs ?? 120;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 3000;
    this.hydrating = this.hydrate();
    this.writeChain = this.hydrating;
  }

  whenHydrated(): Promise<void> {
    return this.hydrating;
  }

  // Resolves once all queued write-throughs have landed in SecureStorage.
  // Useful for a graceful shutdown flush and for tests asserting durability.
  flush(): Promise<void> {
    return this.writeChain;
  }

  get(serverId: string): ServiceCredentials | null {
    return this.cache.get(serverId) ?? null;
  }

  set(serverId: string, creds: ServiceCredentials): void {
    if (!credsHaveContent(creds)) {
      this.clear(serverId);
      return;
    }
    this.cache.set(serverId, creds);
    this.emit(serverId, creds);
    this.queuePersist();
  }

  clear(serverId: string): void {
    this.cache.delete(serverId);
    this.emit(serverId, null);
    this.queuePersist();
  }

  subscribe(serverId: string, fn: ServiceCredentialsListener): () => void {
    let set = this.listeners.get(serverId);
    if (!set) {
      set = new Set();
      this.listeners.set(serverId, set);
    }
    set.add(fn);
    // Synchronous initial fire with the current cache value. If hydration
    // is still in flight this may be null; hydrate() re-emits to every
    // subscribed serverId once the backing finishes loading, so a panel
    // that mounted pre-hydration still settles to the real value.
    try { fn(this.get(serverId)); } catch { /* isolate */ }
    return () => {
      const s = this.listeners.get(serverId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.listeners.delete(serverId);
    };
  }

  subscribeAll(fn: (serverId: string, creds: ServiceCredentials | null) => void): () => void {
    this.globalListeners.add(fn);
    return () => { this.globalListeners.delete(fn); };
  }

  entries(): Array<[string, ServiceCredentials]> {
    return [...this.cache.entries()];
  }

  private emit(serverId: string, value: ServiceCredentials | null): void {
    const set = this.listeners.get(serverId);
    if (set) {
      for (const fn of set) {
        try { fn(value); } catch { /* isolate */ }
      }
    }
    for (const fn of this.globalListeners) {
      try { fn(serverId, value); } catch { /* isolate */ }
    }
  }

  // Persist the full cache as one snapshot, serialized behind any prior
  // write (and behind hydration). Rebuilds the snapshot at execution time
  // from the live cache so the last write always reflects current state.
  private queuePersist(): void {
    this.writeChain = this.writeChain
      .catch(() => { /* ignore prior write failure; keep the chain alive */ })
      .then(() => this.secure.set(SECURE_KEY, JSON.stringify(Object.fromEntries(this.cache))));
  }

  private async hydrate(): Promise<void> {
    // Without a working secure backing (no preload bridge / keychain 'none')
    // we can't securely persist — leave the cache empty and DON'T scrub the
    // legacy plain-text store, so we never destroy the only copy of the data.
    // Poll briefly first: the store constructs at module import, which may
    // beat the preload bridge injection.
    const { available, elapsedMs, probes } = await this.waitForBacking();
    if (!available) {
      log(`hydrate: secure backing UNAVAILABLE after ${elapsedMs}ms / ${probes} probe(s) — keeping plain-text localStorage, NOT migrating`);
      return;
    }
    log(`hydrate: secure backing available after ${elapsedMs}ms / ${probes} probe(s)`);

    // 1. Load the secure map.
    try {
      const raw = await this.secure.get(SECURE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, ServiceCredentials>;
        if (parsed && typeof parsed === 'object') {
          for (const [serverId, creds] of Object.entries(parsed)) {
            if (creds && typeof creds === 'object') this.cache.set(serverId, creds);
          }
        }
      }
      log(`hydrate: loaded ${this.cache.size} server(s) from secure store: [${[...this.cache.keys()].join(', ')}]`);
    } catch (err) {
      log(`hydrate: secure load failed (starting empty): ${String(err)}`);
    }

    // 2. One-time migration of legacy plain-text localStorage entries.
    const migratedKeys = this.migrateLegacy();

    // 3. If we pulled anything in, make sure the secure copy is written,
    //    THEN scrub the legacy plain-text keys.
    if (migratedKeys.length > 0) {
      try {
        await this.secure.set(SECURE_KEY, JSON.stringify(Object.fromEntries(this.cache)));
        // Only delete plain-text after the secure write succeeded.
        for (const key of migratedKeys) this.legacy?.removeItem(key);
        log(`migrate: migrated + scrubbed ${migratedKeys.length} legacy key(s): [${migratedKeys.join(', ')}]`);
      } catch (err) {
        log(`migrate: secure write FAILED — leaving plain-text in place: ${String(err)}`);
      }
    } else {
      log('migrate: no legacy plain-text entries to migrate');
    }

    log(`hydrate: done; cache has ${this.cache.size} server(s)`);

    // 4. Re-emit current values to anyone who subscribed before hydration
    //    finished (initial fire delivered null/stale).
    for (const serverId of this.listeners.keys()) {
      this.emit(serverId, this.get(serverId));
    }
  }

  // Polls isAvailable() until it returns true or the timeout elapses. Returns
  // how long it took + how many probes so the logs make the preload-injection
  // race visible.
  private async waitForBacking(): Promise<{ available: boolean; elapsedMs: number; probes: number }> {
    let probes = 0;
    let elapsed = 0;
    for (;;) {
      probes++;
      let ok = false;
      try { ok = await this.secure.isAvailable(); } catch { ok = false; }
      if (ok) return { available: true, elapsedMs: elapsed, probes };
      if (elapsed >= this.probeTimeoutMs) return { available: false, elapsedMs: elapsed, probes };
      await new Promise((r) => setTimeout(r, this.probeIntervalMs));
      elapsed += this.probeIntervalMs;
    }
  }

  // Reads legacy `boson.services-creds.<serverId>` entries and merges any not
  // already present into the cache. Returns the legacy storage keys that were
  // migrated (to be removed only after a successful secure write).
  private migrateLegacy(): string[] {
    if (!this.legacy) return [];
    const migrated: string[] = [];
    // Snapshot keys first — we'll be removing entries, which would disturb
    // index-based iteration over a live Storage.
    const keys: string[] = [];
    for (let i = 0; i < this.legacy.length; i++) {
      const k = this.legacy.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
    }
    log(`migrate: found ${keys.length} legacy localStorage key(s): [${keys.join(', ')}]`);
    for (const key of keys) {
      const serverId = key.slice(STORAGE_PREFIX.length);
      if (this.cache.has(serverId)) {
        // Secure copy already wins; just scrub the stale plain-text dupe.
        migrated.push(key);
        continue;
      }
      const raw = this.legacy.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as ServiceCredentials;
        if (parsed && typeof parsed === 'object' && credsHaveContent(parsed)) {
          this.cache.set(serverId, parsed);
        }
        migrated.push(key);
      } catch {
        // Corrupt legacy entry — mark for removal anyway; it's unusable.
        migrated.push(key);
      }
    }
    return migrated;
  }
}

// Module-level singleton. The chat service grabs this on construction so
// callers don't have to thread it through every layer; tests can shadow
// it via `setServiceCredentialsStore`.
//
// Lazily constructed so it isn't built at module import — that matters for
// tests (which inject their own via setServiceCredentialsStore before the
// first get, so the secure default with its background hydration poll is
// never created) and lets production construct it on first real use, after
// the preload bridge has had a chance to inject.
let store: ServiceCredentialsStore | null = null;

export function getServiceCredentialsStore(): ServiceCredentialsStore {
  if (!store) {
    // Keychain-backed secure store; migrates + scrubs any legacy plain-text
    // localStorage entries on first run.
    store = new SecureServiceCredentialsStore(windowSecureStorage);
  }
  return store;
}

export function setServiceCredentialsStore(next: ServiceCredentialsStore): void {
  store = next;
}
