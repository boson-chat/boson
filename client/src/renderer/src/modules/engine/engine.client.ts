import type {
  ChannelDirectoryEntry,
  ClientCommand,
  ConnectParams,
  IrcEvent,
  ServerMessage,
  EngineState,
} from './engine.types';

export interface EngineConfig {
  url: string;   // ws://127.0.0.1:7331/ws
  token: string;
}

export type EventListener = (e: IrcEvent) => void;
export type StateListener = (s: EngineState, error?: string) => void;
export type ChannelDirectoryListener = (entries: ChannelDirectoryEntry[]) => void;
export type ReconnectListener = () => void;
// Transport-level errors arrive without a serverId — they can't be routed
// to a ServerSession so consumers subscribe here.
export type TransportErrorListener = (error: string) => void;

// Injectable so tests can stand in a fake WebSocket constructor.
export interface WebSocketCtor {
  new (url: string): WebSocketLike;
}

export interface WebSocketLike {
  readyState: number;
  onopen: ((this: WebSocketLike, ev: Event) => void) | null;
  onclose: ((this: WebSocketLike, ev: CloseEvent) => void) | null;
  onerror: ((this: WebSocketLike, ev: Event) => void) | null;
  onmessage: ((this: WebSocketLike, ev: MessageEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

// Options controlling auto-reconnect after an unexpected WebSocket close.
// Disabled entirely if `false` is passed to the constructor.
export interface ReconnectOptions {
  baseMs?: number;        // default 500
  maxMs?: number;         // default 10000
  maxAttempts?: number;   // default Infinity
  // Optional setTimeout / clearTimeout indirection for tests
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  // Optional jitter source for tests (Math.random by default)
  random?: () => number;
}

export interface EngineClientOptions {
  wsCtor?: WebSocketCtor;
  reconnect?: ReconnectOptions | false;
}

// Resolved reconnect configuration with all defaults applied. `null` when
// auto-reconnect is disabled.
interface ResolvedReconnect {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  random: () => number;
}

// WebSocket readyState constants — duplicated locally so the FakeWS used in
// tests doesn't have to depend on the global WebSocket class for these values.
const WS_CONNECTING = 0;
const WS_OPEN = 1;

// ---------------------------------------------------------------------------
// ServerSession
// ---------------------------------------------------------------------------

// A single IRC connection's surface as seen by higher layers. The
// EngineClient owns the shared WebSocket; ServerSession owns the per-server
// listeners + the "send command tagged with my id" plumbing.
export class ServerSession {
  // Visible to EngineClient for internal routing — read-only to the outside.
  private state_: EngineState = 'connecting';
  private readonly eventListeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly channelDirectoryListeners = new Set<ChannelDirectoryListener>();
  private disposed_ = false;

  constructor(
    public readonly serverId: string,
    private readonly engine: EngineClient,
  ) {}

  state(): EngineState { return this.state_; }

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    fn(this.state_);
    return () => { this.stateListeners.delete(fn); };
  }

  onEvent(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => { this.eventListeners.delete(fn); };
  }

  onChannelDirectory(fn: ChannelDirectoryListener): () => void {
    this.channelDirectoryListeners.add(fn);
    return () => { this.channelDirectoryListeners.delete(fn); };
  }

  join(channel: string): void {
    this.engine._sendForSession({
      type: 'join',
      params: { serverId: this.serverId, channel },
    });
  }

  part(channel: string): void {
    this.engine._sendForSession({
      type: 'part',
      params: { serverId: this.serverId, channel },
    });
  }

  privmsg(target: string, message: string): void {
    this.engine._sendForSession({
      type: 'privmsg',
      params: { serverId: this.serverId, target, message },
    });
  }

  names(channel: string): void {
    this.engine._sendForSession({
      type: 'names',
      params: { serverId: this.serverId, channel },
    });
  }

  // Send an IRCv3 TAGMSG — used for client tags like `+typing`. The engine
  // forwards the tags verbatim; servers that don't support `message-tags`
  // drop them and the frame becomes a no-op.
  tagmsg(target: string, tags: Record<string, string>): void {
    this.engine._sendForSession({
      type: 'tagmsg',
      params: { serverId: this.serverId, target, tags },
    });
  }

  // Ask the server for its channel directory (IRC LIST). Replies stream back
  // as 322 RPL_LIST events, terminated by 323 RPL_LISTEND. ChatService
  // collects them into a per-server cache for the join autocomplete.
  list(): void {
    this.engine._sendForSession({
      type: 'list',
      params: { serverId: this.serverId },
    });
  }

  // Set IRC AWAY status. Empty message clears away (i.e. /BACK). The
  // server replies with RPL_NOWAWAY (306) or RPL_UNAWAY (305) and pushes
  // an AWAY event to every channel member if the away-notify CAP was
  // ACKed at connect time.
  away(message: string): void {
    this.engine._sendForSession({
      type: 'away',
      params: { serverId: this.serverId, message },
    });
  }

  // Change the user's IRC nickname on this server. Server replies with
  // a NICK event on success (which ChatService.handleEvent renames
  // across every channel's member list and updates myNick) or a 4xx
  // numeric on failure, surfaced via the existing error-banner path.
  nick(nick: string): void {
    const next = nick.trim();
    if (!next) return;
    this.engine._sendForSession({
      type: 'nick',
      params: { serverId: this.serverId, nick: next },
    });
  }

  // Tells the engine to tear down THIS server's IRC client. The ServerSession
  // instance stays alive until the engine echoes back state=disconnected,
  // which triggers _dispose() from the EngineClient routing layer.
  disconnect(): void {
    this.engine._sendForSession({
      type: 'disconnect',
      params: { serverId: this.serverId },
    });
  }

  isDisposed(): boolean { return this.disposed_; }

  // --- internal hooks called by EngineClient ---

  _setState(next: EngineState, error?: string): void {
    this.state_ = next;
    this.stateListeners.forEach((fn) => fn(next, error));
  }

  _emitEvent(e: IrcEvent): void {
    this.eventListeners.forEach((fn) => fn(e));
  }

  _emitChannelDirectory(entries: ChannelDirectoryEntry[]): void {
    this.channelDirectoryListeners.forEach((fn) => {
      try { fn(entries); } catch { /* isolate */ }
    });
  }

  _emitError(error: string): void {
    // Surface as a state notification with the current state + error string —
    // matches the legacy onState(state, error?) shape consumers expect.
    this.stateListeners.forEach((fn) => fn(this.state_, error));
  }

  _dispose(): void {
    this.disposed_ = true;
    this.eventListeners.clear();
    this.stateListeners.clear();
    this.channelDirectoryListeners.clear();
  }
}

// ---------------------------------------------------------------------------
// EngineClient
// ---------------------------------------------------------------------------

// EngineClient owns the WebSocket transport + auto-reconnect. IRC-level
// session state lives in ServerSession instances created via connect().
//
// One EngineClient per renderer process. Multiple concurrent ServerSessions
// can be active at once — the engine routes each event to the right one
// based on the `serverId` carried on every wire message.
export class EngineClient {
  private ws: WebSocketLike | null = null;
  private readonly sessions_ = new Map<string, ServerSession>();
  private readonly reconnectListeners = new Set<ReconnectListener>();
  private readonly transportErrorListeners = new Set<TransportErrorListener>();
  // Commands issued before the WebSocket finishes its handshake are queued
  // and flushed in `flushPending` once readyState transitions to OPEN.
  private pendingSends: ClientCommand[] = [];

  private readonly wsCtor: WebSocketCtor;
  private readonly reconnectCfg: ResolvedReconnect | null;
  // Reconnect state. `attempts` counts consecutive failed/unexpected closes;
  // resets to 0 after the next successful open.
  private attempts = 0;
  private reconnectTimer: unknown = null;
  // Set true the moment the caller invokes close() — suppresses auto-reconnect
  // for the in-flight socket's onclose. Reset on the next open() call so a
  // closed-then-reused client can still reconnect.
  private closedByCaller = false;
  // True iff we're inside open() because of an automatic reconnect (i.e.
  // attempts > 0 at the time open() was scheduled). Used to fire onReconnect
  // listeners on success, but NOT on the very first open().
  private reconnecting = false;

  constructor(
    private readonly config: EngineConfig,
    optsOrCtor?: EngineClientOptions | WebSocketCtor,
  ) {
    // Back-compat: the old constructor accepted a bare WebSocketCtor as the
    // second arg. Detect that shape (function) vs the new options object.
    let opts: EngineClientOptions;
    if (typeof optsOrCtor === 'function') {
      opts = { wsCtor: optsOrCtor };
    } else {
      opts = optsOrCtor ?? {};
    }

    this.wsCtor = opts.wsCtor ?? (WebSocket as unknown as WebSocketCtor);

    if (opts.reconnect === false) {
      this.reconnectCfg = null;
    } else {
      const r = opts.reconnect ?? {};
      this.reconnectCfg = {
        baseMs: r.baseMs ?? 500,
        maxMs: r.maxMs ?? 10000,
        maxAttempts: r.maxAttempts ?? Infinity,
        setTimer: r.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown),
        clearTimer: r.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
        random: r.random ?? Math.random,
      };
    }
  }

  open(): Promise<void> {
    if (this.ws) return Promise.resolve();
    // A new open() call clears any prior caller-close flag so this instance
    // can be re-opened after close().
    this.closedByCaller = false;
    // Pending reconnect timer is superseded — if open() is being called
    // explicitly, drop any scheduled retry.
    this.cancelReconnectTimer();

    return new Promise<void>((resolve, reject) => {
      const url = `${this.config.url}?token=${encodeURIComponent(this.config.token)}`;
      const ws = new this.wsCtor(url);
      this.ws = ws;
      // Snapshot at open-time: were we reconnecting? On success, this drives
      // the onReconnect fan-out.
      const wasReconnecting = this.reconnecting;

      ws.onopen = () => {
        this.flushPending();
        // Successful open resets the backoff counter.
        this.attempts = 0;
        this.reconnecting = false;
        if (wasReconnecting) {
          this.reconnectListeners.forEach(fn => {
            try { fn(); } catch { /* listener errors are isolated */ }
          });
        }
        resolve();
      };
      ws.onerror = () => {
        this.ws = null;
        this.pendingSends = [];
        this.markAllSessionsDisconnected('engine: websocket connection failed');
        this.maybeScheduleReconnect();
        reject(new Error('engine: websocket error'));
      };
      ws.onclose = () => {
        this.ws = null;
        this.pendingSends = [];
        this.markAllSessionsDisconnected();
        this.maybeScheduleReconnect();
      };
      ws.onmessage = (ev: MessageEvent) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMessage;
        } catch {
          return;
        }
        this.handle(msg);
      };
    });
  }

  private flushPending(): void {
    const queued = this.pendingSends;
    this.pendingSends = [];
    for (const cmd of queued) {
      // ws is guaranteed non-null here (just opened); safe direct write.
      this.ws!.send(JSON.stringify(cmd));
    }
  }

  isOpen(): boolean { return this.ws !== null; }

  close(): void {
    this.closedByCaller = true;
    this.cancelReconnectTimer();
    this.reconnecting = false;
    this.attempts = 0;
    if (!this.ws) return;
    this.ws.close();
    this.ws = null;
  }

  // Open (or re-use) a ServerSession for the given serverId and tell the
  // engine to connect. If a session already exists for that id this returns
  // the existing handle as-is and does NOT re-send a connect — the engine
  // rejects duplicate connects ("server <id> already connected") and a
  // stray re-issue here would re-set the renderer-side state to 'connecting'
  // even though the IRC client is already live. Callers wanting a fresh
  // attempt should disconnect() first, which removes the session from
  // sessions_ once the engine echoes back state=disconnected.
  //
  // This adoption path matters during identity transitions: when a guest
  // signs in, the renderer rebuilds DirectoryBloc but the engine-side IRC
  // clients keep running (bloc.dispose() intentionally doesn't tear them
  // down). The new bloc calls connect() with the same serverIds and lands
  // here, picking up the existing live sessions instead of fighting the
  // engine for a duplicate.
  connect(params: ConnectParams): ServerSession {
    const existing = this.sessions_.get(params.serverId);
    if (existing) return existing;

    const session = new ServerSession(params.serverId, this);
    this.sessions_.set(params.serverId, session);
    session._setState('connecting');
    this._sendForSession({ type: 'connect', params });
    return session;
  }

  // Returns currently-open sessions in insertion order. Disposed sessions
  // (those whose engine reached `disconnected` and were torn down) are not
  // included.
  sessions(): readonly ServerSession[] {
    return Array.from(this.sessions_.values());
  }

  getSession(serverId: string): ServerSession | null {
    return this.sessions_.get(serverId) ?? null;
  }

  // Subscribe to fires-once-per-auto-reconnect notifications. The callback
  // runs whenever the WebSocket reopens *after* an unexpected close — i.e.
  // not on the very first open(). Used by higher layers to re-issue any
  // `connect({...})` command they need to restore IRC session state.
  onReconnect(fn: ReconnectListener): () => void {
    this.reconnectListeners.add(fn);
    return () => { this.reconnectListeners.delete(fn); };
  }

  // Subscribe to transport-level errors that arrive without a serverId (bad
  // JSON, unknown command, etc.). Per-server errors are routed to the
  // matching ServerSession's onState listeners instead.
  onTransportError(fn: TransportErrorListener): () => void {
    this.transportErrorListeners.add(fn);
    return () => { this.transportErrorListeners.delete(fn); };
  }

  // Internal: ServerSession command surface. Same queue semantics as the
  // pre-refactor private send(): commands sent before the WS opens are
  // buffered and flushed on the next OPEN.
  _sendForSession(cmd: ClientCommand): void {
    if (!this.ws) {
      this.notifySendFailure('engine: not connected');
      return;
    }
    if (this.ws.readyState === WS_CONNECTING) {
      this.pendingSends.push(cmd);
      return;
    }
    if (this.ws.readyState !== WS_OPEN) {
      this.notifySendFailure('engine: socket not open');
      return;
    }
    this.ws.send(JSON.stringify(cmd));
  }

  private notifySendFailure(error: string): void {
    // Best-effort fan-out: every ServerSession that's waiting on a command
    // hears about the failure on its onState listeners. Transport listeners
    // also fire so callers without a session (yet) can react.
    this.sessions_.forEach((s) => s._emitError(error));
    this.transportErrorListeners.forEach((fn) => {
      try { fn(error); } catch { /* isolate */ }
    });
  }

  private handle(msg: ServerMessage): void {
    // Errors without a serverId are genuine transport-level problems (bad
    // JSON, unknown command). Route them to the dedicated listener.
    if (!msg.serverId && msg.type === 'error') {
      if (msg.error) {
        this.transportErrorListeners.forEach((fn) => {
          try { fn(msg.error!); } catch { /* isolate */ }
        });
      }
      return;
    }
    // Events / status frames with no serverId only happen if the engine
    // binary is an older single-session build. We can keep working if there's
    // exactly one open session (the common dev case), but make some noise so
    // the gap is obvious in the console. The fix is to restart `engine serve`
    // against the multi-server binary.
    let session = msg.serverId ? this.sessions_.get(msg.serverId) : null;
    if (!session && !msg.serverId) {
      if (this.sessions_.size === 1) {
        const only = this.sessions_.values().next().value!;
        // eslint-disable-next-line no-console
        console.warn(
          '[engine] received a serverId-less frame; falling back to the only open session. ' +
            'Restart `make engine-serve` to pick up the multi-server engine binary.',
          msg,
        );
        session = only;
      } else {
        // eslint-disable-next-line no-console
        console.warn('[engine] dropping serverId-less frame (no single session to attribute to)', msg);
        return;
      }
    }
    if (!session) return;
    switch (msg.type) {
      case 'event':
        if (msg.event) session._emitEvent(msg.event);
        break;
      case 'channel-directory':
        if (msg.directory) session._emitChannelDirectory(msg.directory);
        break;
      case 'status':
        if (msg.state) {
          session._setState(msg.state);
          if (msg.state === 'disconnected') {
            // Tear down the session — its IRC client is gone on the engine
            // side. Future connect()s for the same serverId mint a fresh
            // ServerSession instance.
            this.sessions_.delete(session.serverId);
            session._dispose();
          }
        }
        break;
      case 'error':
        session._emitError(msg.error ?? 'engine error');
        break;
    }
  }

  private markAllSessionsDisconnected(error?: string): void {
    const sessions = Array.from(this.sessions_.values());
    this.sessions_.clear();
    for (const s of sessions) {
      s._setState('disconnected', error);
      s._dispose();
    }
  }

  // Schedule a reconnect attempt if auto-reconnect is enabled, the caller
  // hasn't explicitly closed us, and we still have attempts to burn. Idempotent
  // — a no-op if a timer is already pending.
  private maybeScheduleReconnect(): void {
    if (!this.reconnectCfg) return;
    if (this.closedByCaller) return;
    if (this.reconnectTimer !== null) return;
    if (this.attempts >= this.reconnectCfg.maxAttempts) return;

    const { baseMs, maxMs, random, setTimer } = this.reconnectCfg;
    // Exponential backoff with full jitter: capped at maxMs, then multiplied
    // by [0.5, 1.0). Prevents thundering-herd on a flapping engine restart.
    const cap = Math.min(baseMs * Math.pow(2, this.attempts), maxMs);
    const delay = cap * (0.5 + random() * 0.5);

    this.reconnectTimer = setTimer(() => {
      this.reconnectTimer = null;
      // Bail if caller closed us between scheduling and firing.
      if (this.closedByCaller) return;
      // Mark "this open() is a reconnect" so onopen fans out to listeners.
      this.reconnecting = true;
      this.attempts += 1;
      this.open().catch(() => {
        // open() rejected — onerror already nulled ws + cleared sessions,
        // and scheduled the next attempt via maybeScheduleReconnect().
      });
    }, delay);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    if (this.reconnectCfg) this.reconnectCfg.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
