import type { AuthService } from '../../modules/auth';
import { ChatService, type ChatState } from '../../modules/chat';
import { PresenceService } from '../../modules/chat/presence.service';
import { setAvatar } from '../../modules/chat/avatar-cache';
import { getServiceCredentialsStore } from '../../modules/chat/services-credentials';
import type { DirectoryService, Server, User } from '../../modules/directory';
import type { EngineClient, EngineState, ServerSession } from '../../modules/engine';
import type { ChatHistoryStore } from '../../modules/history';
import type { IdentityService } from '../../modules/identity';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import { SessionStore, type SavedServer, type SavedSession } from '../../modules/session';
import {
  addLocalServer,
  loadLocalServers,
  mergeWithLocal,
  removeLocalServer,
  type LocalServer,
} from '../../modules/directory/local-servers';

// DirectoryBloc owns the directory + connect + session-restore flow. The
// DirectoryScreen view layer subscribes to this bloc and dispatches user
// intents back through public methods. Mirrors the convention used by
// ChatService / AuthService: private state, `getState()`, `subscribe()`.

// Per-server connection bundle exposed by the bloc state. Consumers see an
// immutable snapshot — internal storage uses the mutable `Connection` shape.
export interface DirectoryConnection {
  serverId: string;
  server: Server | SavedServer;
  chat: ChatService;
  engineState: EngineState;
  // Most recent engine/IRC-level error for this connection. Surfaced in the
  // disconnected splash so users see *why* a session dropped instead of a
  // bare "Disconnected." Cleared when the connection reaches `connected`.
  error: string | null;
  // Auto-reconnect state for this connection. `active` is true while the
  // bloc is in the auto-reconnect cycle — either waiting for the next
  // backoff timer to fire OR actively running a connect attempt. Goes
  // false when (a) we reach `connected`, (b) the user clicks Cancel, or
  // (c) the user disconnects explicitly.
  reconnect: { active: boolean };
}

interface Connection {
  serverId: string;
  server: Server | SavedServer;
  chat: ChatService;
  session: ServerSession;
  engineState: EngineState;
  error: string | null;
  unsubscribeState: () => void;
  unsubscribeChat: () => void;
  unsubscribePresence: () => void;
}

interface AutoReconnectState {
  // True once the user has clicked Cancel. Sticky: a fresh attempt
  // requires an explicit Reconnect click to clear this.
  cancelled: boolean;
  // Failed-attempt counter, used to pick the backoff delay. Reset to
  // zero on every successful 'connected'.
  attempts: number;
  // Timer for the next attempt during a backoff wait. Null while we're
  // actively running an attempt (engineState 'connecting') or after
  // we've reached 'connected' / been cancelled.
  nextAttemptTimer: ReturnType<typeof setTimeout> | null;
}

// Backoff schedule: 1s, 2s, 4s, 8s, 15s, 15s, 15s, … capped so we
// keep trying indefinitely without hammering the server. The user
// can always click Reconnect to skip whatever delay is pending.
const AUTO_RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export interface DirectoryState {
  me: User | null | undefined;
  servers: Server[] | null;
  filteredServers: Server[] | null;
  query: string;
  language: string;
  showNsfw: boolean;
  error: string | null;
  // All currently-open connections, ordered by insertion. The active one is
  // identified by `activeServerId`.
  connections: ReadonlyArray<DirectoryConnection>;
  activeServerId: string | null;
  showChat: boolean;
  // True from the moment a saved-session restore kicks off until either the
  // engine reaches `connected` (and `showChat` flips) or the restore aborts.
  // The view uses this to render a splash instead of the directory list,
  // so users don't see the directory flash before chat loads.
  restoring: boolean;
  // True when the directory list should be presented as an overlay modal on
  // top of an active chat — i.e. the user clicked the `+` in the server rail
  // to add/switch servers. Independent of `showChat`: the IRC session keeps
  // running while the modal is open.
  serverBrowserOpen: boolean;
}

// Pull the snapshot for the active connection, or null if none/disconnected.
// View code that used to read `state.chat`, `state.connectedServer`, etc.
// goes through these helpers instead.
export function activeConnection(state: DirectoryState): DirectoryConnection | null {
  if (state.activeServerId === null) return null;
  return state.connections.find((c) => c.serverId === state.activeServerId) ?? null;
}

// Aggregate engine state for the engine pill: returns 'connected' if any
// connection is connected, 'connecting' if any is mid-handshake, 'idle' if
// there are no connections, else 'disconnected'.
export function aggregateEngineState(state: DirectoryState): EngineState {
  if (state.connections.length === 0) return 'idle';
  if (state.connections.some((c) => c.engineState === 'connected')) return 'connected';
  if (state.connections.some((c) => c.engineState === 'connecting')) return 'connecting';
  return 'disconnected';
}

export type DirectoryListener = (s: DirectoryState) => void;

export interface DirectoryBlocDeps {
  auth: AuthService;
  directory: DirectoryService;
  identity: IdentityService;
  engine: EngineClient | null;
  sessionStore?: SessionStore;
  // Optional chat-message history store. When provided alongside a resolvable
  // userId (via getUserId()), ChatService is constructed with per-channel
  // persistence enabled. When either is missing, the bloc falls back to the
  // legacy in-memory-only behaviour.
  history?: ChatHistoryStore;
  getUserId?: () => string | null;
  // Guest mode: when set, the bloc uses this nick as a synthetic User and
  // skips the backend /me call entirely. Servers list is still fetched.
  guestNick?: string;
}

const SEARCH_DEBOUNCE_MS = 200;

export class DirectoryBloc {
  private readonly auth: AuthService;
  private readonly directory: DirectoryService;
  private readonly identity: IdentityService;
  private readonly engine: EngineClient | null;
  private readonly sessionStore: SessionStore;
  private readonly history: ChatHistoryStore | null;
  private readonly getUserId: () => string | null;

  private me: User | null | undefined = undefined;
  private servers: Server[] | null = null;
  private query = '';
  private language = 'all';
  private showNsfw = false;
  private error: string | null = null;
  // Insertion-ordered map of serverId → connection. We rely on Map's
  // insertion order so the ServerRail renders tiles in the order the user
  // added them.
  private readonly connections = new Map<string, Connection>();
  private activeServerId: string | null = null;
  private serverBrowserOpen = false;

  private readonly listeners = new Set<DirectoryListener>();
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  // A deep-link join parsed before `me` was loaded — `connectWith` bails
  // when `me.handle` is missing, so the join would silently no-op
  // during the load-initial race window. Stashed here and replayed by
  // `maybeFlushPendingDeepLink()` once `me` lands.
  private pendingDeepLinkJoin: {
    host: string;
    port: number;
    tls: boolean;
    name?: string;
  } | null = null;
  // Per-server auto-reconnect state. When a connection drops, the bloc
  // schedules a fresh connect attempt with exponential backoff. The
  // user can override via the disconnected splash:
  //   - "Reconnect now" (manual) clears the cancelled flag and skips
  //     the pending backoff timer, kicking off an attempt immediately.
  //   - "Cancel" sets cancelled=true, clears the timer, and the cycle
  //     stops; the user has to click Reconnect manually to resume.
  // `cancelled` is sticky across attempts within a wedge, so a single
  // Cancel click won't immediately re-arm on the next drop.
  private autoReconnect = new Map<string, AutoReconnectState>();
  // Backend session-sync plumbing. Single debounced PUT collapses bursts of
  // SessionStore mutations (e.g. JOIN echoes during reconnect) into one
  // network round-trip. Unsubscribe + timer cleared on dispose.
  private unsubscribeSessionSync: (() => void) | null = null;
  private sessionSyncTimer: ReturnType<typeof setTimeout> | null = null;

  // Channels we still need to (re)join for the just-restored server once
  // its engine reaches connected state. Keyed by serverId for forward-compat
  // with multi-server restore.
  private pendingJoins = new Map<string, string[]>();
  // Guard against double-restoring on repeated state notifications.
  private restored = false;
  // True while a restore is in flight — set when we know a saved session
  // exists and we've started the reconnect, cleared once the engine reaches
  // connected (showChat=true) or the restore fails / never starts.
  private restoring = false;
  // Latest list query token — drops late responses if a newer query started.
  private listToken = 0;

  // Mutable so DirectoryScreen can flip identity mid-session via
  // setIdentity() (guest ↔ account) without rebuilding the bloc.
  private guestNick: string | null;

  constructor(deps: DirectoryBlocDeps) {
    this.auth = deps.auth;
    this.directory = deps.directory;
    this.identity = deps.identity;
    this.engine = deps.engine;
    this.sessionStore = deps.sessionStore ?? new SessionStore();
    this.history = deps.history ?? null;
    this.guestNick = deps.guestNick ?? null;
    // Default reads the Supabase session synchronously. Tests can override.
    // In guest mode there's no Supabase user so this returns null — chat
    // persistence falls back to in-memory only, which is the right default
    // for an anonymous session.
    this.getUserId = deps.getUserId ?? (() => this.auth.getState().session?.user?.id ?? null);

    // Pre-flag the restoring state at construction time, BEFORE the view's
    // first render, so it never sees `restoring=false` with a saved session
    // still pending. The maybeRestoreSession() flow will clear it if a
    // restore can't actually proceed. Guest sessions also restore their
    // saved server set; identity isn't required for IRC connections.
    if (deps.engine && this.sessionStore.load()) {
      if (this.guestNick || this.identity.isUnlocked()) this.restoring = true;
    }

    void this.loadInitial();
  }

  // ---- Observation ----

  getState(): DirectoryState {
    const showChat = this.computeShowChat();
    return {
      me: this.me,
      servers: this.servers,
      filteredServers: this.computeFiltered(),
      query: this.query,
      language: this.language,
      showNsfw: this.showNsfw,
      error: this.error,
      connections: this.snapshotConnections(),
      activeServerId: this.activeServerId,
      showChat,
      restoring: this.restoring && !showChat,
      serverBrowserOpen: this.serverBrowserOpen,
    };
  }

  subscribe(fn: DirectoryListener): () => void {
    this.listeners.add(fn);
    fn(this.getState());
    return () => { this.listeners.delete(fn); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    if (this.sessionSyncTimer) {
      clearTimeout(this.sessionSyncTimer);
      this.sessionSyncTimer = null;
    }
    this.unsubscribeSessionSync?.();
    this.unsubscribeSessionSync = null;
    // Cancel every pending auto-reconnect timer so a fired timer
    // can't resurrect work against a disposed bloc.
    for (const ar of this.autoReconnect.values()) {
      if (ar.nextAttemptTimer !== null) {
        clearTimeout(ar.nextAttemptTimer);
        ar.nextAttemptTimer = null;
      }
    }
    this.autoReconnect.clear();
    // Tear down every open connection in deterministic order.
    for (const c of Array.from(this.connections.values())) {
      this.teardownConnection(c, { sendDisconnect: false });
    }
    this.connections.clear();
    this.listeners.clear();
  }

  // ---- Filters ----

  setQuery(q: string): void {
    if (this.query === q) return;
    this.query = q;
    this.emit();
    this.scheduleSearch();
  }

  setLanguage(l: string): void {
    if (this.language === l) return;
    this.language = l;
    this.emit();
  }

  setShowNsfw(v: boolean): void {
    if (this.showNsfw === v) return;
    this.showNsfw = v;
    this.emit();
  }

  setMe(u: User): void {
    this.me = u;
    this.emit();
    this.maybeRestoreSession();
  }

  // Flip the bloc between guest and account modes WITHOUT tearing down any
  // running IRC connections. DirectoryScreen calls this when the guestNick
  // prop changes (e.g. the user clicked "Switch to an account" in settings
  // and then signed in) so the same bloc instance survives the transition —
  // the engine sessions, ChatServices, and SessionStore state all stay put.
  //
  // Caveats — these are the things this method intentionally does NOT do:
  //   - Existing ServerSessions keep their IRC-level identity (the nick that
  //     was registered at connect-time). Re-registering with a new nick
  //     requires a /nick command from the chat input — we don't force one.
  //   - ChatService persistence scope is fixed at connectWith() time, so
  //     conversations that started as guest stay in their original scope
  //     (typically in-memory only). New servers joined after the transition
  //     pick up the new userId via getUserId() and persist normally.
  setIdentity(next: { guestNick: string | null }): void {
    if (this.guestNick === next.guestNick) return;
    this.guestNick = next.guestNick;
    if (next.guestNick) {
      // Account → guest. Synthesise me from the new nick; no backend round
      // trip. The `__guest__` id matches loadInitial()'s synthesis so
      // anything keyed on me.id stays consistent.
      this.me = {
        id: '__guest__',
        handle: next.guestNick,
        is_discoverable: false,
        encrypted_user_secret: '',
        created_at: new Date().toISOString(),
      };
      this.emit();
      this.maybeRestoreSession();
      this.maybeFlushPendingDeepLink();
      return;
    }
    // Guest → account. Clear the synthesised guest user and re-run the
    // initial load against the now-authenticated session. loadInitial()
    // re-fetches /me, refreshes the directory list, adopts the cloud-saved
    // session, and (re-)attaches session sync. The restore guard prevents
    // it from racing the connections we already have.
    this.me = undefined;
    this.emit();
    void this.loadInitial();
  }

  // Switch the active server in the rail. No-op if the id doesn't match an
  // open connection. The view uses `activeServerId` to decide which
  // ChatService to render in the centre pane.
  setActiveServer(serverId: string): void {
    if (!this.connections.has(serverId)) return;
    if (this.activeServerId === serverId) return;
    this.activeServerId = serverId;
    this.applyForegroundState();
    this.sessionStore.setActiveServer(serverId);
    this.applyForegroundState();
    this.emit();
  }

  // Open a conversation surfaced from the Inbox: focus its server (and show
  // chat) and, for a DM, open + activate the sender's DM tab. No-op when the
  // memo's server isn't a live connection (e.g. it arrived in a past session
  // we haven't reconnected). Returns true if it navigated.
  openConversation(serverId: string, target: string | null): boolean {
    const conn = this.connections.get(serverId);
    if (!conn) return false;
    this.activeServerId = serverId;
    this.sessionStore.setActiveServer(serverId);
    if (target) conn.chat.openDM(target);
    this.applyForegroundState();
    this.emit();
    return true;
  }

  // Fetch a memo's body on demand (Inbox open of an unread memo). Routes
  // to the originating server's ChatService without switching the active
  // server — the body fills into the Inbox in place. No-op if that
  // connection isn't currently open.
  readMemo(serverId: string, memoIndex: number): boolean {
    const conn = this.connections.get(serverId);
    if (!conn) return false;
    conn.chat.readMemo(memoIndex);
    return true;
  }

  // Refresh the signed-in user's avatar everywhere without a reconnect:
  // update `me` (so presence re-publishes the right URL) and re-pin the
  // avatar cache under the user's current nick on every open connection, so
  // it updates live in the chat stream + member list.
  setOwnAvatar(url: string | null): void {
    if (this.me) this.me = { ...this.me, avatar_url: url ?? undefined };
    for (const conn of this.connections.values()) {
      setAvatar(conn.serverId, conn.chat.selfIdentity().nick, url);
    }
    this.emit();
  }

  // Flag each chat service with whether its server is the one currently being
  // viewed. ChatService uses this to decide whether incoming messages count
  // as unread (they always do for non-foreground servers; for the foreground
  // server, only non-active channels bump).
  private applyForegroundState(): void {
    for (const conn of this.connections.values()) {
      conn.chat.setForeground(conn.serverId === this.activeServerId);
    }
  }

  // Backend session sync — only enabled for authenticated users (guests
  // stay local-only). Subscribes to SessionStore mutations and debounces
  // them into a single PUT /me/session. 750ms is enough to collapse the
  // typical "JOIN echo flurry" during a server reconnect into one request.
  private static readonly SESSION_SYNC_DEBOUNCE_MS = 750;
  private attachSessionSync(): void {
    if (this.guestNick) return;
    if (this.unsubscribeSessionSync) return;
    this.unsubscribeSessionSync = this.sessionStore.onChange((snap) => {
      if (this.sessionSyncTimer) clearTimeout(this.sessionSyncTimer);
      this.sessionSyncTimer = setTimeout(() => {
        this.sessionSyncTimer = null;
        if (this.disposed) return;
        // Push the current snapshot — even null, so deletes propagate to
        // the backend. The directory's PUT validates that payload is a
        // JSON object, so empty deletes go through as `{}`.
        const payload: unknown = snap ?? {};
        void this.directory.putSavedSession(payload).catch(() => {
          // Best-effort — keep working offline; we'll retry on the next change.
        });
      }, DirectoryBloc.SESSION_SYNC_DEBOUNCE_MS);
    });
  }

  // Re-open the chat overlay if at least one connection is connected (e.g.
  // user clicked the engine pill while looking at the directory).
  openChat(): void {
    if (this.connections.size === 0) return;
    // Prefer the active connection; otherwise pick the first connected one.
    if (this.activeServerId && this.connections.get(this.activeServerId)?.engineState === 'connected') {
      this.emit();
      return;
    }
    const firstConnected = Array.from(this.connections.values()).find((c) => c.engineState === 'connected');
    if (!firstConnected) return;
    this.activeServerId = firstConnected.serverId;
    this.applyForegroundState();
    this.emit();
  }

  // Open the directory-as-modal overlay (the `+` in the server rail). The
  // current IRC sessions stay alive — this is a UI affordance, not a
  // disconnect. No-op if already open.
  openServerBrowser(): void {
    if (this.serverBrowserOpen) return;
    this.serverBrowserOpen = true;
    this.emit();
  }

  // Close the directory-as-modal overlay (Cancel / Escape / row-connect).
  closeServerBrowser(): void {
    if (!this.serverBrowserOpen) return;
    this.serverBrowserOpen = false;
    this.emit();
  }

  // ---- Connect / disconnect ----

  async connect(server: Server): Promise<void> {
    const existing = this.connections.get(server.id);
    if (existing) {
      // Same-server guard generalised: if a connection already exists in
      // connecting/connected state for this server, just switch to it and
      // close the modal. A disconnected (wedged) connection falls through
      // to the replace-then-reconnect path below.
      if (existing.engineState === 'connecting' || existing.engineState === 'connected') {
        let changed = false;
        if (this.activeServerId !== server.id) {
          this.activeServerId = server.id;
          this.applyForegroundState();
          changed = true;
        }
        if (this.serverBrowserOpen) { this.serverBrowserOpen = false; changed = true; }
        if (changed) this.emit();
        return;
      }
      // Existing-but-disconnected: tear it down so we mint a fresh
      // ServerSession + ChatService below. BEFORE tearing down, snapshot
      // the channels the user was in so the fresh session re-joins them
      // — without this, the user clicks "Reconnect" and lands on an
      // empty channel list. The same `pendingJoins` mechanism that
      // session-restore uses on cold boot drives the replay (the
      // `connected` callback in connectWith() drains it).
      //
      // We prefer the saved-session list over the chat service's
      // current channel set: the chat service can race during a wedge
      // (membership state can be stale) but sessionStore is updated
      // only on user-driven join/part, so it's the canonical "what the
      // user expects to be in" set.
      const saved = this.sessionStore.load();
      const savedServer = saved?.servers.find((s) => s.server.id === server.id);
      const channelsToRejoin = savedServer?.channels ?? [];
      if (channelsToRejoin.length > 0) {
        this.pendingJoins.set(server.id, channelsToRejoin.slice());
      }
      this.teardownConnection(existing, { sendDisconnect: false });
      this.connections.delete(server.id);
    }
    await this.connectWith(server);
    if (this.serverBrowserOpen) {
      this.serverBrowserOpen = false;
      this.emit();
    }
  }

  // Drop a single named connection. Other connections continue running.
  disconnect(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    // User-initiated disconnect: kill any pending auto-reconnect so
    // the cycle doesn't resurrect the connection moments later.
    const ar = this.autoReconnect.get(serverId);
    if (ar?.nextAttemptTimer !== undefined && ar.nextAttemptTimer !== null) {
      clearTimeout(ar.nextAttemptTimer);
    }
    this.autoReconnect.delete(serverId);
    this.teardownConnection(conn, { sendDisconnect: true });
    this.connections.delete(serverId);
    if (this.activeServerId === serverId) {
      // Promote the next remaining connection (insertion order) — or fall
      // back to null when there are none.
      const next = this.connections.keys().next();
      this.activeServerId = next.done ? null : next.value!;
      this.applyForegroundState();
    }
    // Drop ONLY this server from the saved set. Other connections (if any)
    // remain restorable on next launch.
    this.sessionStore.removeServer(serverId);
    if (this.activeServerId !== null) {
      this.sessionStore.setActiveServer(this.activeServerId);
    }
    this.emit();
  }

  // Drop the ACTIVE connection (engine pill / directory disconnect button).
  // Other connections persist; the active id rolls forward to the next
  // remaining connection or null. Only the active server is removed from
  // the saved set — siblings remain so the next sign-in still restores them.
  disconnectAndBrowse(): void {
    const activeId = this.activeServerId;
    if (activeId === null) {
      // Nothing active — just close the modal. Don't clear the saved set;
      // there may be other servers worth restoring next time.
      this.restored = true;
      this.restoring = false;
      this.serverBrowserOpen = false;
      this.emit();
      return;
    }
    this.sessionStore.removeServer(activeId);
    this.pendingJoins.delete(activeId);
    this.restored = true;
    this.restoring = false;
    const conn = this.connections.get(activeId);
    if (conn) {
      this.teardownConnection(conn, { sendDisconnect: true });
      this.connections.delete(activeId);
    }
    const next = this.connections.keys().next();
    this.activeServerId = next.done ? null : next.value!;
    this.applyForegroundState();
    if (this.activeServerId !== null) {
      this.sessionStore.setActiveServer(this.activeServerId);
    }
    this.serverBrowserOpen = false;
    this.emit();
  }

  // Reconnect the currently-active server. Used by ChatArea's "Disconnected"
  // splash so the user can re-establish without bouncing back to the
  // directory. No-op if there's nothing active. We route through connect()
  // rather than re-implementing the teardown/replace dance — its
  // existing-but-disconnected branch already handles wedged sessions.
  async reconnectActive(): Promise<void> {
    const activeId = this.activeServerId;
    if (activeId === null) return;
    const conn = this.connections.get(activeId);
    if (!conn) return;
    // Manual reconnect — clear any pending backoff timer + reset the
    // cancelled flag so the auto-reconnect cycle resumes after this
    // attempt (if it fails). Counts as an explicit user action.
    const ar = this.autoReconnect.get(activeId);
    if (ar) {
      if (ar.nextAttemptTimer !== null) {
        clearTimeout(ar.nextAttemptTimer);
        ar.nextAttemptTimer = null;
      }
      ar.cancelled = false;
    }
    // Server records carry the same shape whether they came from the live
    // directory list (`Server`) or a saved session (`SavedServer`); connect()
    // accepts either via its Server-typed parameter.
    await this.connect(conn.server as Server);
  }

  // Stop the auto-reconnect cycle for the active connection. The next
  // attempt's backoff timer is cancelled and the cancelled flag is set
  // so subsequent 'disconnected' transitions won't auto-arm. The user
  // can still kick off a manual reconnect via `reconnectActive()`,
  // which clears the cancelled flag.
  cancelReconnectActive(): void {
    const activeId = this.activeServerId;
    if (activeId === null) return;
    this.cancelAutoReconnect(activeId);
  }

  // Schedule the next reconnect attempt for `serverId` after the
  // current backoff window. Skips if (a) the user has cancelled, or
  // (b) a timer is already pending (idempotent guard so multiple
  // disconnect events in a row don't stack timers).
  private scheduleAutoReconnect(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    let ar = this.autoReconnect.get(serverId);
    if (!ar) {
      ar = { cancelled: false, attempts: 0, nextAttemptTimer: null };
      this.autoReconnect.set(serverId, ar);
    }
    if (ar.cancelled) return;
    if (ar.nextAttemptTimer !== null) return;
    const delayMs = AUTO_RECONNECT_BACKOFF_MS[
      Math.min(ar.attempts, AUTO_RECONNECT_BACKOFF_MS.length - 1)
    ]!;
    ar.nextAttemptTimer = setTimeout(() => {
      const state = this.autoReconnect.get(serverId);
      if (state) state.nextAttemptTimer = null;
      // The connection may have been removed (user-initiated
      // disconnect) between scheduling and firing — guard so we don't
      // resurrect a dead entry.
      if (!this.connections.has(serverId)) return;
      if (state) state.attempts += 1;
      // connect() routes through the existing wedge → teardown →
      // connectWith path, which seeds pendingJoins from sessionStore
      // so channels are rejoined on the fresh session.
      void this.connect(conn.server as Server);
    }, delayMs);
    this.emit();
  }

  // Stop the auto-reconnect cycle for `serverId`: clear the pending
  // timer and mark the state as cancelled so future drops don't
  // re-arm. Idempotent.
  private cancelAutoReconnect(serverId: string): void {
    let ar = this.autoReconnect.get(serverId);
    if (!ar) {
      ar = { cancelled: true, attempts: 0, nextAttemptTimer: null };
      this.autoReconnect.set(serverId, ar);
      this.emit();
      return;
    }
    if (ar.nextAttemptTimer !== null) {
      clearTimeout(ar.nextAttemptTimer);
      ar.nextAttemptTimer = null;
    }
    ar.cancelled = true;
    this.emit();
  }

  // Called after a successful 'connected' transition. Clears the
  // attempt counter so the next drop starts fresh from the lowest
  // backoff delay. We deliberately don't clear `cancelled` here —
  // a user who cancelled an auto-reconnect cycle wouldn't want it
  // silently re-enabled just because the manual reconnect they then
  // triggered eventually succeeded.
  private resetAutoReconnect(serverId: string): void {
    const ar = this.autoReconnect.get(serverId);
    if (!ar) return;
    if (ar.nextAttemptTimer !== null) {
      clearTimeout(ar.nextAttemptTimer);
      ar.nextAttemptTimer = null;
    }
    ar.attempts = 0;
  }

  // Is the auto-reconnect cycle currently running for this server?
  // True if neither cancelled nor has the connection succeeded.
  private isAutoReconnectActive(serverId: string): boolean {
    const ar = this.autoReconnect.get(serverId);
    if (!ar) return false;
    return !ar.cancelled;
  }

  async signOut(): Promise<void> {
    this.sessionStore.clear();
    // Clear the OS-keychain–persisted user_secret BEFORE auth.signOut so the
    // userId is still available. Then drop the in-memory secret and finally
    // tear down the Supabase session. Order matters: if auth.signOut fired
    // first, we'd lose the userId needed to namespace the keychain key.
    const userId = this.auth.getState().session?.user?.id;
    if (userId) {
      await this.identity.clearStorage(userId);
      // Drop every persisted chat scrollback for this user across all servers.
      // Sign-out is the user explicitly saying "forget about me"; leaving old
      // logs behind would leak history into the next account on this device.
      if (this.history) {
        try {
          await this.history.wipeAllForUser(userId);
        } catch {
          // Best-effort — proceeding with sign-out even if storage hiccups.
        }
      }
    }
    this.identity.lock();
    await this.auth.signOut();
  }

  // ---- Internals ----

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.getState();
    this.listeners.forEach((fn) => fn(snapshot));
  }

  private snapshotConnections(): ReadonlyArray<DirectoryConnection> {
    return Array.from(this.connections.values()).map((c) => ({
      serverId: c.serverId,
      server: c.server,
      chat: c.chat,
      engineState: c.engineState,
      error: c.error,
      reconnect: { active: this.isAutoReconnectActive(c.serverId) },
    }));
  }

  // showChat is true iff we have an active connection in the map — its
  // engineState doesn't matter for whether the chat shell renders. A
  // `connecting` or `disconnected` server still belongs on the rail with an
  // empty-but-named chat view; tossing the user back to the directory just
  // because they clicked a non-`connected` tile would be jarring. The
  // ChannelSidebar / ChatArea handle empty channel lists gracefully and the
  // ServerRail dims tiles per their engineState so the user can still see
  // which one is healthy.
  private computeShowChat(): boolean {
    if (this.activeServerId === null) return false;
    return this.connections.has(this.activeServerId);
  }

  private computeFiltered(): Server[] | null {
    if (!this.servers) return null;
    // Merge backend servers with user-added local entries. Backend wins on
    // hostname collision (the public registration is the source of truth
    // if both exist). Local-only filters (NSFW, language) apply uniformly
    // — local entries default to languages=[] so the `all` filter shows
    // them and any other language filter hides them, which feels right.
    const merged = mergeWithLocal(this.servers, loadLocalServers());
    return merged.filter((s) => {
      if (!this.showNsfw && s.is_nsfw) return false;
      if (this.language !== 'all' && !s.languages.includes(this.language)) return false;
      return true;
    });
  }

  // Advanced-mode action: persist a user-entered server locally + emit so
  // the directory list re-renders with it merged in.
  addLocalServer(input: { name: string; hostname: string; port: number; tls: boolean }): LocalServer {
    const created = addLocalServer(input);
    this.emit();
    return created;
  }

  // Patch an owner-mutable subset of fields on a directory row.
  // Returns once the backend confirms — the bloc then folds the
  // updated server into its in-memory list so the Edit tab's preview
  // (and any other UI binding to bloc state) reflects the change.
  // Errors propagate to the caller (ServerSettings.EditProfileSection)
  // which surfaces them as a form-level banner.
  async updateServerProfile(
    serverID: string,
    patch: Partial<{
      name: string;
      description: string;
      tags: string[];
      languages: string[];
      isNsfw: boolean;
    }>,
  ): Promise<void> {
    const updated = await this.directory.updateServerProfile(serverID, {
      name: patch.name,
      description: patch.description,
      tags: patch.tags,
      languages: patch.languages,
      is_nsfw: patch.isNsfw,
    });
    // Refresh the row in our in-memory `servers` list + the matching
    // connection's `server` snapshot so the UI binds to fresh data
    // without a full /servers re-fetch.
    if (this.servers) {
      this.servers = this.servers.map((s) => (s.id === serverID ? updated : s));
    }
    const conn = this.connections.get(serverID);
    if (conn) conn.server = updated;
    this.emit();
  }

  // Deep-link handler. The marketing site's /discover page links to
  // `boson://join?host=…&port=…&tls=…&name=…` for every directory card;
  // the main process passes the parsed params here.
  //
  // Two paths:
  //   1. We already know a server (directory or local) with the same
  //      hostname:port → connect to that record. Preserves description,
  //      tags, language filters, and the "CURRENTLY CONNECTED" banner.
  //   2. Otherwise → add as a local server so the user has an entry
  //      they can remove later, then connect to it.
  async joinFromDeepLink(input: {
    host: string;
    port: number;
    tls: boolean;
    name?: string;
  }): Promise<void> {
    // `connectWith` requires `me.handle` to mint an IRC nick — without
    // it the connection is a no-op. The bloc is constructed before
    // `loadInitial` resolves, so a deep-link that fires during the
    // initial round-trip would silently drop on the floor. Stash the
    // intent and replay it after `loadInitial` finishes.
    if (!this.me?.handle) {
      console.info('[deep-link] join deferred — me not yet loaded');
      this.pendingDeepLinkJoin = input;
      return;
    }
    const hostKey = input.host.trim().toLowerCase();
    const existing = [
      ...(this.servers ?? []),
      ...mergeWithLocal([], loadLocalServers()),
    ].find((s) => s.hostname.toLowerCase() === hostKey && s.port === input.port);
    if (existing) {
      await this.connect(existing);
      return;
    }
    const created = addLocalServer({
      name: input.name?.trim() || input.host,
      hostname: input.host,
      port: input.port,
      tls: input.tls,
    });
    this.emit();
    // mergeWithLocal will pick the freshly-persisted entry up — fetch
    // it back as a Server and connect.
    const merged = mergeWithLocal(this.servers ?? [], loadLocalServers());
    const target = merged.find((s) => s.id === created.id);
    if (target) await this.connect(target);
  }

  // Replay a deep-link join that arrived before `me` was loaded.
  // Called after each `me` assignment + after each successful
  // `loadInitial`. Idempotent — clears the pending slot before running
  // so a synchronous re-entry can't loop.
  private maybeFlushPendingDeepLink(): void {
    if (!this.pendingDeepLinkJoin) return;
    if (!this.me?.handle) return;
    const params = this.pendingDeepLinkJoin;
    this.pendingDeepLinkJoin = null;
    console.info('[deep-link] flushing buffered join', { host: params.host, port: params.port });
    void this.joinFromDeepLink(params);
  }

  // Remove a previously-added local server. No-op if id isn't local.
  removeLocalServer(id: string): void {
    removeLocalServer(id);
    this.emit();
  }

  private async loadInitial(): Promise<void> {
    try {
      // Guest mode: synthesise a User from the local nick — no backend /me
      // call. The id `__guest__` is stable across reloads so chat-history
      // scoping has a consistent key for the guest's local-only logs.
      if (this.guestNick) {
        const list = await this.directory.listServers();
        if (this.disposed) return;
        this.me = {
          id: '__guest__',
          handle: this.guestNick,
          is_discoverable: false,
          encrypted_user_secret: '',
          created_at: new Date().toISOString(),
        };
        this.servers = list;
        this.emit();
        this.maybeRestoreSession();
        this.maybeFlushPendingDeepLink();
        return;
      }
      const [user, list, remoteSession] = await Promise.all([
        this.directory.getMe(),
        this.directory.listServers(),
        // Cloud-synced saved session for the signed-in user. Returns the
        // last-PUT payload or null if nothing's stored yet. Failures here
        // are non-fatal — we fall back to whatever's in localStorage.
        this.directory.getSavedSession().catch(() => null),
      ]);
      if (this.disposed) return;
      this.me = user;
      this.servers = list;
      // If the backend has a saved session, adopt it as authoritative —
      // last-write-wins across devices. Use saveSilent so applying the
      // remote state doesn't immediately PUT it back to the server.
      if (remoteSession && typeof remoteSession === 'object') {
        try {
          this.sessionStore.saveSilent(remoteSession as SavedSession);
        } catch { /* best-effort */ }
      }
      // Now that the saved session is in place, start pushing local changes
      // back. The subscription is set up after the initial adoption so the
      // very first emit from `saveSilent` doesn't trigger a redundant PUT.
      this.attachSessionSync();
      this.emit();
      this.maybeRestoreSession();
      this.maybeFlushPendingDeepLink();
    } catch (e) {
      if (this.disposed) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  private scheduleSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const token = ++this.listToken;
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.runSearch(token);
    }, SEARCH_DEBOUNCE_MS);
  }

  private async runSearch(token: number): Promise<void> {
    try {
      const list = await this.directory.listServers({ q: this.query || undefined });
      // If a newer search started while we were in flight, drop this result.
      if (this.disposed || token !== this.listToken) return;
      this.servers = list;
      this.emit();
    } catch (e) {
      if (this.disposed || token !== this.listToken) return;
      this.error = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  // Force a fresh fetch of the public directory list using the current
  // query as-is. Bumps listToken so any in-flight debounced search
  // result drops on arrival — the explicit refresh wins. Called from
  // the header's manual "Refresh" button AND when the add-server
  // modal closes (which may have left a newly-verified row that
  // needs to show up in the grid).
  refreshDirectory(): void {
    this.listToken += 1;
    void this.runSearch(this.listToken);
  }

  private maybeRestoreSession(): void {
    if (this.restored) return;
    if (!this.engine || !this.me?.handle) {
      // Engine missing or no handle yet — restore can't proceed. Clear the
      // splash if we optimistically set it in the constructor.
      if (this.restoring && this.me !== undefined) {
        this.restoring = false;
        this.emit();
      }
      return;
    }
    // Identity is only required for account mode (SASL key derivation, etc.).
    // Guests connect anonymously, so we still proceed when locked.
    if (!this.guestNick && !this.identity.isUnlocked()) return;
    const saved = this.sessionStore.load();
    if (!saved || saved.servers.length === 0) {
      if (this.restoring) {
        this.restoring = false;
        this.emit();
      }
      return;
    }
    this.restored = true;
    this.restoring = true;
    // Queue all channels per server before kicking off connects so the
    // `connected` callback can replay joins as each server reaches ready.
    for (const s of saved.servers) {
      this.pendingJoins.set(s.server.id, s.channels.slice());
    }
    // Restore the active-server choice before issuing connects so the rail
    // starts on the right tile from the very first emit. If the saved
    // activeServerId is missing or stale, fall back to the first record.
    const restoreActive = saved.activeServerId
      && saved.servers.some((s) => s.server.id === saved.activeServerId)
      ? saved.activeServerId
      : saved.servers[0]!.server.id;
    this.activeServerId = restoreActive;
    this.applyForegroundState();
    // Spin up every saved server's IRC session in parallel.
    for (const s of saved.servers) {
      void this.connectWith(s.server);
    }
  }

  // Build a brand-new connection (ServerSession + ChatService + listeners) for
  // the given server, store it in the map, and fire off the engine connect.
  private async connectWith(server: Server | SavedServer): Promise<void> {
    if (!this.engine || !this.me?.handle) return;
    // Already have a live Connection record for this server? Skip — caller
    // paths overlap (user-initiated connect, saved-session restore, and the
    // setIdentity flow can all reach here concurrently). Re-running would
    // overwrite the existing Connection in `this.connections` and orphan
    // its subscriptions on the engine session. Callers that genuinely want
    // to reconnect a wedged server tear the entry down first.
    if (this.connections.has(server.id)) return;

    // Wire up per-channel persistence iff both the store and a userId are
    // available. Either being null falls back to legacy in-memory-only chat —
    // the message log dies with the page but otherwise everything still works.
    const userId = this.getUserId();
    const persistence = this.history && userId
      ? { history: this.history, scope: { userId, serverId: server.id, serverName: server.name } }
      : undefined;

    if (this.disposed) return;

    // Connect with no SASL by default. The previous always-on SASL path used
    // an HMAC of (user_secret, serverId) which only Boson-native servers can
    // verify; public networks like Libera reject it as a bad SASL PLAIN. The
    // intended model is per-server `auth: 'none' | 'nickserv-sasl' |
    // 'boson-sasl'` stored on SavedServer, configured via server settings.
    // Until that lands we always connect anonymously — users can still
    // /msg NickServ REGISTER on networks where they want a registered nick.
    //
    // Sanitize the Boson handle into an IRC-legal nick — boson handles are
    // typically email-shaped, but IRC servers reject `@` and `.` with 432
    // ERR_ERRONEUSNICKNAME and registration stalls silently.
    const ircNick = sanitizeIrcNick(this.me.handle);
    // Pull the stored NickServ password for this server (if any) so
    // the engine can auto-identify after RPL_WELCOME. Plain-text in
    // localStorage today; same path that the Advanced settings panel
    // writes to. Empty / absent disables auto-identify.
    // Wait for the credentials store to hydrate from its (async) secure
    // backing before reading — otherwise a cold-start saved-server auto-
    // connect could read an empty cache and silently skip auto-identify.
    // No-op on the sync localStorage store (no whenHydrated).
    const credStore = getServiceCredentialsStore();
    await credStore.whenHydrated?.();
    const storedCreds = credStore.get(server.id);
    const session = this.engine.connect({
      serverId: server.id,
      hostname: server.hostname,
      port: server.port,
      tls: server.tls,
      nick: ircNick,
      nickservPassword: storedCreds?.nickservPassword,
    });
    // Pass the nick-claim API so signed-in users get the automated
    // claim flow. The interface is the minimal subset of
    // DirectoryService — anything that has a working backend HTTP
    // channel satisfies it.
    const chat = new ChatService(session, ircNick, persistence, {
      nickClaimAPI: {
        createNickClaim: (input) => this.directory.createNickClaim(input),
        getNickClaim: (id) => this.directory.getNickClaim(id),
      },
    });
    chat.attach();

    const conn: Connection = {
      serverId: server.id,
      server,
      chat,
      session,
      engineState: session.state(),
      error: null,
      unsubscribeState: () => {},
      unsubscribeChat: () => {},
      unsubscribePresence: () => {},
    };

    // Presence: publish our IRC identity for this connection + resolve other
    // members into profile images (avatar cache). No-ops while signed-out /
    // before the network name is known. Falls back to the server hostname as
    // the cross-client network key when the server sends no NETWORK= token.
    conn.unsubscribePresence = new PresenceService(
      chat,
      {
        publishPresence: (input) => this.directory.publishPresence(input),
        lookupPresence: (network, members) => this.directory.lookupPresence(network, members),
        ownAvatarUrl: () => this.me?.avatar_url,
      },
      server.id,
      server.hostname,
      () => !this.guestNick && this.getUserId() !== null,
    ).start();

    // Per-server engine state subscription. The ServerSession's first
    // notification fires synchronously with the current state ('connecting'
    // immediately after connect()); subsequent updates flow from incoming
    // status messages.
    conn.unsubscribeState = session.onState((state, sessionError) => {
      conn.engineState = state;
      // Surface session-level errors (engine refused connect, IRC 4xx/5xx
      // numeric, etc.) on the connection itself — without this the splash
      // would just say "Disconnected" with no reason.
      if (sessionError) conn.error = sessionError;
      // Clear stale errors once we successfully reach connected.
      if (state === 'connected') conn.error = null;
      if (state === 'connected') {
        // Reset the auto-reconnect counters — the cycle is over.
        this.resetAutoReconnect(server.id);
        // Replay any pending joins for this server now that IRC is ready.
        const queued = this.pendingJoins.get(server.id);
        if (queued && queued.length > 0) {
          this.pendingJoins.delete(server.id);
          // Defer to the next microtask so subscribers see the connected
          // state before joins are issued.
          queueMicrotask(() => {
            if (this.disposed) return;
            queued.forEach((ch) => conn.chat.join(ch));
          });
        }
        if (this.restoring) this.restoring = false;
      }
      if (state === 'disconnected' || state === 'idle') {
        if (this.restoring) this.restoring = false;
        // If we landed in disconnected without any explicit error reported,
        // fill in a generic reason so the splash isn't blank — the engine's
        // stdout logs will have the technical detail.
        if (state === 'disconnected' && !conn.error) {
          conn.error = 'Connection closed without an error message — check the engine terminal for details.';
        }
        // Schedule the next reconnect attempt (no-op if cancelled or
        // already-disposed). Idle is the pre-connect resting state and
        // not a drop, so we skip auto-reconnect for it.
        if (state === 'disconnected') {
          this.scheduleAutoReconnect(server.id);
        }
      }
      this.emit();
    });

    // Persist this connection into the saved-session set. SessionStore v2
    // keeps one record per server so a multi-server session round-trips
    // across launches. `upsertServer` refreshes name/host details too.
    this.sessionStore.upsertServer({
      id: server.id, name: server.name, hostname: server.hostname,
      port: server.port, tls: server.tls,
    });

    // Re-render trigger only — ChatService state changes need to flow into
    // the bloc's snapshot so the view re-renders the unread badges etc.
    // Persistence is NOT derived from this stream because a freshly-rebuilt
    // ChatService emits an empty channel list during reconnect, which would
    // otherwise overwrite the saved channels we're about to re-join.
    const unsubRender = chat.subscribe(() => this.emit());

    // Persistence: react only to user-initiated membership transitions.
    // - join: add this channel to the saved set (idempotent)
    // - part: user explicitly left → remove from saved set
    // - kick: server kicked us → remove from saved set
    // Connection drops fire NO events, so saved channels stay intact across
    // reconnects. Sessions / rejoins re-confirm the saved set via add.
    const unsubMembership = chat.onSelfMembership((event) => {
      switch (event.kind) {
        case 'join':
          this.sessionStore.addChannel(conn.serverId, event.channel);
          break;
        case 'part':
        case 'kick':
          this.sessionStore.removeChannel(conn.serverId, event.channel);
          break;
      }
    });

    // Active-channel cursor: persist it so the saved session restores back to
    // the same channel the user was reading. Subscribing to chat state and
    // mirroring activeChannel is safe — even a fresh ChatService starts with
    // activeChannel=null, which is the right default. The previous value
    // remains valid until setActive() updates it.
    let lastSavedActive: string | null = null;
    const unsubActive = chat.subscribe((state: ChatState) => {
      if (state.activeChannel !== lastSavedActive) {
        lastSavedActive = state.activeChannel;
        if (state.activeChannel !== null) {
          this.sessionStore.setActiveChannel(conn.serverId, state.activeChannel);
        }
      }
    });

    conn.unsubscribeChat = () => {
      unsubRender();
      unsubMembership();
      unsubActive();
    };

    this.connections.set(server.id, conn);
    this.activeServerId = server.id;
    this.applyForegroundState();

    // Pre-emit so subscribers see the new connection immediately, even
    // before the engine's first onState notification.
    this.emit();
  }

  // Drop listeners + (optionally) send a per-server disconnect to the engine.
  private teardownConnection(c: Connection, opts: { sendDisconnect: boolean }): void {
    c.unsubscribeState();
    c.unsubscribeChat();
    c.unsubscribePresence();
    c.chat.detach();
    if (opts.sendDisconnect && !c.session.isDisposed()) {
      c.session.disconnect();
    }
  }
}
