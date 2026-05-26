import type { AuthService } from '../../modules/auth';
import { ChatService, type ChatState } from '../../modules/chat';
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
}

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
      // ServerSession + ChatService below.
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
    // Server records carry the same shape whether they came from the live
    // directory list (`Server`) or a saved session (`SavedServer`); connect()
    // accepts either via its Server-typed parameter.
    await this.connect(conn.server as Server);
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
      ? { history: this.history, scope: { userId, serverId: server.id } }
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
    const session = this.engine.connect({
      serverId: server.id,
      hostname: server.hostname,
      port: server.port,
      tls: server.tls,
      nick: ircNick,
    });
    const chat = new ChatService(session, ircNick, persistence);
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
    };

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
    c.chat.detach();
    if (opts.sendDisconnect && !c.session.isDisposed()) {
      c.session.disconnect();
    }
  }
}
