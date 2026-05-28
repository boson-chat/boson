import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DirectoryBloc, type DirectoryState, activeConnection } from './DirectoryBloc';
import type { AuthService } from '../../modules/auth';
import type { DirectoryService, Server, User } from '../../modules/directory';
import type {
  EngineClient, EngineState, EventListener, IrcEvent, ServerSession, StateListener,
  ConnectParams,
} from '../../modules/engine';
import type { IdentityService } from '../../modules/identity';
import { SessionStore } from '../../modules/session';

// --- Fakes ----------------------------------------------------------------

function fakeAuth(): AuthService {
  return {
    signOut: vi.fn(async () => {}),
    getState: () => ({ session: null, loading: false, error: null }),
    subscribe: () => () => {},
  } as unknown as AuthService;
}

function fakeIdentity(opts: { unlocked?: boolean; sasl?: string } = {}): IdentityService {
  const unlocked = opts.unlocked ?? true;
  return {
    isUnlocked: () => unlocked,
    getState: () => ({ status: unlocked ? 'unlocked' : 'locked' as const }),
    subscribe: () => () => {},
    saslPasswordForServer: vi.fn(async () => opts.sasl ?? 'pw'),
    getPendingEncrypted: () => null,
    clearPendingEncrypted: () => {},
    persist: vi.fn(async () => true),
    restoreFromStorage: vi.fn(async () => false),
    clearStorage: vi.fn(async () => {}),
    lock: vi.fn(),
  } as unknown as IdentityService;
}

// Per-server fake session. Tracks the state, listeners, and outbound commands
// so tests can assert per-server isolation.
class FakeServerSession {
  state_: EngineState = 'connecting';
  joinCalls: string[] = [];
  partCalls: string[] = [];
  privmsgCalls: Array<{ target: string; message: string }> = [];
  namesCalls: string[] = [];
  tagmsgCalls: Array<{ target: string; tags: Record<string, string> }> = [];
  listCalls = 0;
  disconnectCalls = 0;
  disposed_ = false;
  private stateListeners = new Set<StateListener>();
  private eventListeners = new Set<EventListener>();
  private channelDirectoryListeners = new Set<(entries: { name: string; userCount: number; topic: string }[]) => void>();

  constructor(public readonly serverId: string) {}

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
  onChannelDirectory(fn: (entries: { name: string; userCount: number; topic: string }[]) => void): () => void {
    this.channelDirectoryListeners.add(fn);
    return () => { this.channelDirectoryListeners.delete(fn); };
  }
  join(channel: string): void { this.joinCalls.push(channel); }
  part(channel: string): void { this.partCalls.push(channel); }
  privmsg(target: string, message: string): void { this.privmsgCalls.push({ target, message }); }
  names(channel: string): void { this.namesCalls.push(channel); }
  tagmsg(target: string, tags: Record<string, string>): void { this.tagmsgCalls.push({ target, tags }); }
  list(): void { this.listCalls++; }
  disconnect(): void { this.disconnectCalls++; }
  isDisposed(): boolean { return this.disposed_; }
  // setForeground is invoked by DirectoryBloc.applyForegroundState; ignore.
  setForeground(_v: boolean): void { /* no-op */ }

  // Test-only drivers
  _setState(s: EngineState, error?: string): void {
    this.state_ = s;
    this.stateListeners.forEach((fn) => fn(s, error));
  }
  _emitEvent(e: IrcEvent): void {
    this.eventListeners.forEach((fn) => fn(e));
  }
  _dispose(): void {
    this.disposed_ = true;
    this.eventListeners.clear();
    this.stateListeners.clear();
    this.channelDirectoryListeners.clear();
  }
}

interface FakeEngine {
  client: EngineClient;
  // All connect() calls in order.
  connectCalls: ConnectParams[];
  // serverId → session, in insertion order matching connectCalls.
  sessions: Map<string, FakeServerSession>;
  // Per-session helpers for driving state transitions.
  sessionFor(serverId: string): FakeServerSession;
}

function fakeEngine(): FakeEngine {
  const sessions = new Map<string, FakeServerSession>();
  const connectCalls: ConnectParams[] = [];
  const f: FakeEngine = {
    client: {} as EngineClient,
    connectCalls,
    sessions,
    sessionFor(serverId) {
      const s = sessions.get(serverId);
      if (!s) throw new Error(`no session for ${serverId}`);
      return s;
    },
  };
  f.client = {
    connect: (params: ConnectParams) => {
      connectCalls.push(params);
      let s = sessions.get(params.serverId);
      if (!s) {
        s = new FakeServerSession(params.serverId);
        sessions.set(params.serverId, s);
      }
      s.state_ = 'connecting';
      return s;
    },
    sessions: () => Array.from(sessions.values()) as unknown as ServerSession[],
    getSession: (id: string) => sessions.get(id) as unknown as ServerSession | null,
    onReconnect: () => () => {},
    onTransportError: () => () => {},
    isOpen: () => true,
    open: async () => {},
    close: () => {},
  } as unknown as EngineClient;
  return f;
}

function fakeServer(id: string, overrides: Partial<Server> = {}): Server {
  return {
    id, hostname: `irc.${id}`, port: 6697, tls: true, name: id,
    tags: [], languages: ['en'], is_nsfw: false, is_featured: false,
    verification_status: 'pending', health_status: 'unknown',
    registered_at: '2026-01-01',
    ...overrides,
  };
}

function fakeUser(handle = 'alice'): User {
  return { id: 'u1', handle, is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' };
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: () => null,
    get length() { return map.size; },
  } as Storage;
}

function fakeDirectory(opts: {
  user?: User | null;
  servers?: Server[];
  list?: DirectoryService['listServers'];
}): DirectoryService {
  return {
    getMe: vi.fn(async () => opts.user ?? null),
    listServers: opts.list ?? (vi.fn(async () => opts.servers ?? [])),
    setupMe: vi.fn(),
    deleteMe: vi.fn(),
    getSavedSession: vi.fn(async () => null),
    putSavedSession: vi.fn(async () => undefined),
  } as unknown as DirectoryService;
}

// flushPromises returns a promise that resolves after pending microtasks +
// macrotasks have drained. Needed because the bloc kicks off work in its
// constructor via promise chains.
async function flushPromises(times = 2): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// --- Tests ----------------------------------------------------------------

describe('DirectoryBloc', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('initial state: me undefined, servers null, defaults', () => {
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser(), servers: [fakeServer('a')] }),
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    const s = bloc.getState();
    expect(s.me).toBeUndefined();
    expect(s.servers).toBeNull();
    expect(s.filteredServers).toBeNull();
    expect(s.query).toBe('');
    expect(s.language).toBe('all');
    expect(s.showNsfw).toBe(false);
    expect(s.error).toBeNull();
    expect(s.connections).toEqual([]);
    expect(s.activeServerId).toBeNull();
    expect(s.showChat).toBe(false);
    expect(s.serverBrowserOpen).toBe(false);
    bloc.dispose();
  });

  it('loadInitial populates me + servers and notifies subscribers', async () => {
    const directory = fakeDirectory({
      user: fakeUser('alice'),
      servers: [fakeServer('a'), fakeServer('b')],
    });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    const seen: DirectoryState[] = [];
    bloc.subscribe((s) => { seen.push(s); });
    await flushPromises(4);
    const last = seen[seen.length - 1]!;
    expect(last.me?.handle).toBe('alice');
    expect(last.servers).toHaveLength(2);
    expect(last.filteredServers).toHaveLength(2);
    bloc.dispose();
  });

  it('loadInitial surfaces errors via state.error', async () => {
    const directory = {
      getMe: vi.fn(async () => { throw new Error('boom'); }),
      listServers: vi.fn(async () => []),
      setupMe: vi.fn(),
      deleteMe: vi.fn(),
      getSavedSession: vi.fn(async () => null),
      putSavedSession: vi.fn(async () => undefined),
    } as unknown as DirectoryService;
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    expect(bloc.getState().error).toBe('boom');
    bloc.dispose();
  });

  it('setQuery re-queries after debounce with q param', async () => {
    vi.useFakeTimers();
    const listServers = vi.fn(async () => [fakeServer('libera')]) as unknown as DirectoryService['listServers'];
    const directory = fakeDirectory({ user: fakeUser(), list: listServers });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await vi.runAllTimersAsync();
    (listServers as ReturnType<typeof vi.fn>).mockClear();

    bloc.setQuery('foss');
    expect(listServers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(201);
    expect((listServers as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toEqual({ q: 'foss' });
    bloc.dispose();
  });

  it('setQuery coalesces rapid typing into a single search', async () => {
    vi.useFakeTimers();
    const listServers = vi.fn(async () => [fakeServer('a')]) as unknown as DirectoryService['listServers'];
    const directory = fakeDirectory({ user: fakeUser(), list: listServers });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await vi.runAllTimersAsync();
    (listServers as ReturnType<typeof vi.fn>).mockClear();

    bloc.setQuery('f');
    await vi.advanceTimersByTimeAsync(50);
    bloc.setQuery('fo');
    await vi.advanceTimersByTimeAsync(50);
    bloc.setQuery('foo');
    await vi.advanceTimersByTimeAsync(50);
    expect(listServers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(201);
    expect(listServers).toHaveBeenCalledTimes(1);
    expect((listServers as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({ q: 'foo' });
    bloc.dispose();
  });

  it('setLanguage updates filteredServers without re-querying the network', async () => {
    const en = fakeServer('en1', { languages: ['en'] });
    const es = fakeServer('es1', { languages: ['es'] });
    const listServers = vi.fn(async () => [en, es]) as unknown as DirectoryService['listServers'];
    const directory = fakeDirectory({ user: fakeUser(), list: listServers });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    (listServers as ReturnType<typeof vi.fn>).mockClear();

    bloc.setLanguage('es');
    const s = bloc.getState();
    expect(s.language).toBe('es');
    expect(s.filteredServers).toHaveLength(1);
    expect(s.filteredServers?.[0]?.id).toBe('es1');
    expect(listServers).not.toHaveBeenCalled();
    bloc.dispose();
  });

  it('setShowNsfw toggles NSFW servers in filteredServers', async () => {
    const safe = fakeServer('safe', { is_nsfw: false });
    const naughty = fakeServer('naughty', { is_nsfw: true });
    const directory = fakeDirectory({ user: fakeUser(), servers: [safe, naughty] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    expect(bloc.getState().filteredServers?.map((s) => s.id)).toEqual(['safe']);

    bloc.setShowNsfw(true);
    expect(bloc.getState().filteredServers?.map((s) => s.id)).toEqual(['safe', 'naughty']);
    bloc.dispose();
  });

  it('setMe transitions me from null and triggers session restore when eligible', async () => {
    const storage = memoryStorage();
    const sessionStore = new SessionStore(storage);
    sessionStore.save({
      servers: [{
        server: { id: 's1', name: 's1', hostname: 'irc.s1', port: 6697, tls: true },
        channels: ['#general'],
        activeChannel: '#general',
      }],
      activeServerId: 's1',
    });
    const directory = fakeDirectory({ user: null, servers: [] });
    const engine = fakeEngine();
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore,
    });
    await flushPromises(4);
    expect(engine.connectCalls).toHaveLength(0);

    bloc.setMe(fakeUser('alice'));
    await flushPromises(4);
    expect(engine.connectCalls).toHaveLength(1);
    expect(engine.connectCalls[0]?.hostname).toBe('irc.s1');
    expect(engine.connectCalls[0]?.serverId).toBe('s1');
    bloc.dispose();
  });

  it('connect() saves session, attaches chat, and calls engine.connect anonymously', async () => {
    const storage = memoryStorage();
    const sessionStore = new SessionStore(storage);
    const engine = fakeEngine();
    const server = fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true });
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
    // Even with an unlocked identity that could derive a SASL password, we
    // never send SASL — public networks reject Boson's HMAC and we don't yet
    // have per-server opt-in for NickServ credentials.
    const identity = fakeIdentity({ unlocked: true, sasl: 'derived-pw' });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity,
      engine: engine.client,
      sessionStore,
    });
    await flushPromises(4);

    await bloc.connect(server);
    await flushPromises(2);

    // Session is persisted with the connected server anchor.
    const saved = sessionStore.load();
    expect(saved?.servers[0]?.server.id).toBe('libera');
    expect(saved?.servers[0]?.channels).toEqual([]);
    expect(saved?.activeServerId).toBe('libera');

    // Engine was told to connect — anonymously, no SASL frame.
    expect(engine.connectCalls).toHaveLength(1);
    expect(engine.connectCalls[0]?.nick).toBe('alice');
    expect(engine.connectCalls[0]?.serverId).toBe('libera');
    expect(engine.connectCalls[0]?.sasl).toBeUndefined();

    // Bloc now exposes a connection for the new server.
    const s = bloc.getState();
    expect(s.connections).toHaveLength(1);
    expect(s.activeServerId).toBe('libera');
    expect(activeConnection(s)?.server.id).toBe('libera');
    bloc.dispose();
  });

  // Repro for the "client opens but server doesn't join" bug from clicking
  // boson:// links while the bloc's loadInitial round-trip is still in flight.
  // connectWith() requires me.handle and bails silently if it's missing —
  // so a deep-link parsed during that window has to be buffered + replayed.
  it('joinFromDeepLink buffers the join when me is not yet loaded and replays after loadInitial', async () => {
    const engine = fakeEngine();
    let resolveMe: (u: User | null) => void = () => {};
    const meReady = new Promise<User | null>((r) => { resolveMe = r; });
    const directory = {
      getMe: vi.fn(() => meReady),
      listServers: vi.fn(async () => [
        fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true }),
      ]),
      setupMe: vi.fn(),
      deleteMe: vi.fn(),
      getSavedSession: vi.fn(async () => null),
      putSavedSession: vi.fn(async () => undefined),
    } as unknown as DirectoryService;

    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });

    // Fire the deep-link BEFORE me resolves. The old code's connectWith
    // would silently bail, leaving connectCalls empty.
    await bloc.joinFromDeepLink({ host: 'irc.libera.chat', port: 6697, tls: true });
    await flushPromises(2);
    expect(engine.connectCalls).toHaveLength(0);

    // Now resolve me — the buffered join should replay automatically.
    resolveMe(fakeUser('alice'));
    await flushPromises(6);

    expect(engine.connectCalls).toHaveLength(1);
    expect(engine.connectCalls[0]?.serverId).toBe('libera');
    expect(engine.connectCalls[0]?.nick).toBe('alice');
    bloc.dispose();
  });

  it('joinFromDeepLink with a host not in the directory adds a local server and connects to it', async () => {
    const engine = fakeEngine();
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);

    // Clean up any local-server entry a previous test may have left
    // behind in localStorage — local servers are persisted to the
    // window's localStorage and survive between bloc instances.
    if (typeof globalThis.localStorage !== 'undefined') {
      globalThis.localStorage.removeItem('boson.local-servers');
    }

    await bloc.joinFromDeepLink({ host: 'irc.example.test', port: 6697, tls: true, name: 'Example' });
    await flushPromises(4);

    expect(engine.connectCalls).toHaveLength(1);
    expect(engine.connectCalls[0]?.hostname).toBe('irc.example.test');
    expect(engine.connectCalls[0]?.port).toBe(6697);
    expect(engine.connectCalls[0]?.tls).toBe(true);
    bloc.dispose();
  });

  it('connect() never sends SASL when identity is locked either', async () => {
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser(), servers: [server] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: false }),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);

    await bloc.connect(server);
    expect(engine.connectCalls[0]?.sasl).toBeUndefined();
    bloc.dispose();
  });

  it('disconnectAndBrowse() tears down the active connection, clears session', async () => {
    const storage = memoryStorage();
    const sessionStore = new SessionStore(storage);
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser(), servers: [server] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: engine.client,
      sessionStore,
    });
    await flushPromises(4);
    await bloc.connect(server);
    expect(sessionStore.load()).not.toBeNull();

    bloc.disconnectAndBrowse();
    expect(engine.sessionFor('s1').disconnectCalls).toBe(1);
    expect(sessionStore.load()).toBeNull();
    const s = bloc.getState();
    expect(s.connections).toEqual([]);
    expect(s.activeServerId).toBeNull();
    expect(s.showChat).toBe(false);
    bloc.dispose();
  });

  it('signOut() clears the session store then calls auth.signOut', async () => {
    const storage = memoryStorage();
    const sessionStore = new SessionStore(storage);
    sessionStore.save({
      servers: [{
        server: { id: 's1', name: 's1', hostname: 'h', port: 6697, tls: true },
        channels: [], activeChannel: null,
      }],
      activeServerId: 's1',
    });
    const auth = fakeAuth();
    const order: string[] = [];
    (auth.signOut as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('signOut');
      if (sessionStore.load() === null) order.push('sessionCleared');
    });
    const bloc = new DirectoryBloc({
      auth,
      directory: fakeDirectory({ user: fakeUser() }),
      identity: fakeIdentity(),
      engine: null,
      sessionStore,
    });
    await flushPromises(4);

    await bloc.signOut();
    expect(sessionStore.load()).toBeNull();
    expect(auth.signOut).toHaveBeenCalled();
    expect(order).toEqual(['signOut', 'sessionCleared']);
    bloc.dispose();
  });

  it('per-server engine state changes are reflected in the connection without ejecting the user to the directory', async () => {
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser(), servers: [server] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    await bloc.connect(server);

    engine.sessionFor('s1')._setState('connected');
    expect(bloc.getState().connections[0]?.engineState).toBe('connected');
    expect(bloc.getState().showChat).toBe(true);

    // Disconnect mid-session: the per-connection engineState flips, but the
    // chat shell stays mounted. The rail dims the tile (CSS) and the user
    // sees an empty chat for that server rather than being thrown back to
    // the directory. Only an explicit disconnect (removing the connection
    // entirely) flips showChat to false.
    engine.sessionFor('s1')._setState('disconnected');
    expect(bloc.getState().connections[0]?.engineState).toBe('disconnected');
    expect(bloc.getState().showChat).toBe(true);

    bloc.disconnect('s1');
    expect(bloc.getState().connections).toHaveLength(0);
    expect(bloc.getState().showChat).toBe(false);
    bloc.dispose();
  });

  it('pendingJoins from session restore replay once engine connects', async () => {
    const storage = memoryStorage();
    const sessionStore = new SessionStore(storage);
    sessionStore.save({
      servers: [{
        server: { id: 's1', name: 's1', hostname: 'irc.s1', port: 6697, tls: true },
        channels: ['#general', '#help'],
        activeChannel: '#general',
      }],
      activeServerId: 's1',
    });
    const engine = fakeEngine();
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore,
    });
    await flushPromises(4);
    expect(engine.connectCalls).toHaveLength(1);

    engine.sessionFor('s1')._setState('connected');
    await flushPromises(4);
    expect(engine.sessionFor('s1').joinCalls).toContain('#general');
    expect(engine.sessionFor('s1').joinCalls).toContain('#help');
    bloc.dispose();
  });

  it('dispose() tears down connections and stops emitting state', async () => {
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser(), servers: [server] }),
      identity: fakeIdentity(),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    const calls: DirectoryState[] = [];
    bloc.subscribe((s) => { calls.push(s); });
    await flushPromises(4);
    await bloc.connect(server);
    const before = calls.length;
    bloc.dispose();
    engine.sessionFor('s1')._setState('connected');
    // No state emission after dispose, and the per-connection listeners
    // were detached so the bloc didn't crash.
    expect(calls.length).toBe(before);
  });

  it('openServerBrowser / closeServerBrowser toggle serverBrowserOpen', async () => {
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser(), servers: [] }),
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    expect(bloc.getState().serverBrowserOpen).toBe(false);

    let emits = 0;
    bloc.subscribe(() => { emits++; });
    const baseline = emits;

    bloc.openServerBrowser();
    expect(bloc.getState().serverBrowserOpen).toBe(true);
    expect(emits).toBeGreaterThan(baseline);

    const afterOpen = emits;
    bloc.openServerBrowser();
    expect(emits).toBe(afterOpen);

    bloc.closeServerBrowser();
    expect(bloc.getState().serverBrowserOpen).toBe(false);

    const afterClose = emits;
    bloc.closeServerBrowser();
    expect(emits).toBe(afterClose);
    bloc.dispose();
  });

  it('connect() to the currently-connected server is a no-op and closes the browser', async () => {
    const engine = fakeEngine();
    const server = fakeServer('libera');
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    await bloc.connect(server);
    engine.sessionFor('libera')._setState('connected');
    expect(engine.connectCalls).toHaveLength(1);

    bloc.openServerBrowser();
    expect(bloc.getState().serverBrowserOpen).toBe(true);

    await bloc.connect(server);
    expect(engine.connectCalls).toHaveLength(1);
    expect(engine.sessionFor('libera').disconnectCalls).toBe(0);
    const s = bloc.getState();
    expect(s.serverBrowserOpen).toBe(false);
    expect(s.showChat).toBe(true);
    bloc.dispose();
  });

  it('connect() to a different server adds a second concurrent connection', async () => {
    const engine = fakeEngine();
    const a = fakeServer('a');
    const b = fakeServer('b', { hostname: 'irc.b' });
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [a, b] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    await bloc.connect(a);
    engine.sessionFor('a')._setState('connected');

    bloc.openServerBrowser();

    await bloc.connect(b);
    await flushPromises(2);
    // Both servers exist concurrently. Active id is the just-connected one.
    expect(engine.connectCalls).toHaveLength(2);
    expect(engine.connectCalls[1]?.hostname).toBe('irc.b');
    const s = bloc.getState();
    expect(s.connections.map((c) => c.serverId).sort()).toEqual(['a', 'b']);
    expect(s.activeServerId).toBe('b');
    expect(s.serverBrowserOpen).toBe(false);
    // Engine was NOT told to disconnect the original — it stays open.
    expect(engine.sessionFor('a').disconnectCalls).toBe(0);
    bloc.dispose();
  });

  it('disconnect(id) removes one connection and leaves others running', async () => {
    const engine = fakeEngine();
    const a = fakeServer('a');
    const b = fakeServer('b');
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [a, b] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    await bloc.connect(a);
    engine.sessionFor('a')._setState('connected');
    await bloc.connect(b);
    engine.sessionFor('b')._setState('connected');

    bloc.disconnect('a');
    expect(engine.sessionFor('a').disconnectCalls).toBe(1);
    expect(engine.sessionFor('b').disconnectCalls).toBe(0);
    const s = bloc.getState();
    expect(s.connections.map((c) => c.serverId)).toEqual(['b']);
    expect(s.activeServerId).toBe('b');
    bloc.dispose();
  });

  it('setActiveServer switches active without affecting other connections', async () => {
    const engine = fakeEngine();
    const a = fakeServer('a');
    const b = fakeServer('b');
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [a, b] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    await bloc.connect(a);
    engine.sessionFor('a')._setState('connected');
    await bloc.connect(b);
    engine.sessionFor('b')._setState('connected');
    // b is currently active.
    expect(bloc.getState().activeServerId).toBe('b');

    bloc.setActiveServer('a');
    expect(bloc.getState().activeServerId).toBe('a');
    // No engine traffic from a switch.
    expect(engine.connectCalls).toHaveLength(2);
    expect(engine.sessionFor('a').disconnectCalls).toBe(0);
    expect(engine.sessionFor('b').disconnectCalls).toBe(0);
    bloc.dispose();
  });

  it('one server dropping disconnected does not disturb the other', async () => {
    const engine = fakeEngine();
    const a = fakeServer('a');
    const b = fakeServer('b');
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [a, b] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    await bloc.connect(a);
    engine.sessionFor('a')._setState('connected');
    await bloc.connect(b);
    engine.sessionFor('b')._setState('connected');
    bloc.setActiveServer('a');
    expect(bloc.getState().showChat).toBe(true);

    // b drops; a is still connected — showChat must remain true.
    engine.sessionFor('b')._setState('disconnected');
    const s = bloc.getState();
    expect(s.showChat).toBe(true);
    expect(s.connections.find((c) => c.serverId === 'a')?.engineState).toBe('connected');
    expect(s.connections.find((c) => c.serverId === 'b')?.engineState).toBe('disconnected');
    bloc.dispose();
  });

  it('chat subscription mirrors joined channels into sessionStore for the active server', async () => {
    const storage = memoryStorage();
    const sessionStore = new SessionStore(storage);
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore,
    });
    await flushPromises(4);
    await bloc.connect(server);
    await flushPromises(2);

    // Drive a JOIN event through the engine; ChatService should mark the
    // channel joined and the bloc's chat-subscription should mirror it.
    engine.sessionFor('s1')._emitEvent({ Kind: 'JOIN', From: 'alice', Target: '#general', Message: '', Raw: '' });
    const saved = sessionStore.load();
    const entry = saved?.servers.find((s) => s.server.id === 's1');
    expect(entry?.channels).toContain('#general');
    bloc.dispose();
  });

  // setIdentity is what lets the bloc survive a guest → account flip. The
  // scenario these tests pin: a user connects to a server as guest, then
  // signs in. Tearing down the bloc would orphan the engine session and
  // leave the UI stuck on "connecting" (the engine rejects duplicate
  // connects). Instead, the same bloc keeps the live connections and just
  // re-keys `me`.
  describe('setIdentity', () => {
    it('guest → account: clears synthesised me, kicks off backend /me fetch, keeps live connections', async () => {
      const storage = memoryStorage();
      const sessionStore = new SessionStore(storage);
      const engine = fakeEngine();
      const server = fakeServer('libera');
      // Start authenticated-looking but provide guestNick so the bloc takes
      // the guest path on construction.
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(),
        directory,
        identity: fakeIdentity({ unlocked: true }),
        engine: engine.client,
        sessionStore,
        guestNick: 'guest42',
      });
      await flushPromises(4);

      // Guest synthesised — me.id is the well-known guest sentinel and
      // getMe() was never called.
      expect(bloc.getState().me?.id).toBe('__guest__');
      expect(bloc.getState().me?.handle).toBe('guest42');
      expect(directory.getMe).not.toHaveBeenCalled();

      // Connect to a server as the guest. Engine session is live.
      await bloc.connect(server);
      await flushPromises(2);
      expect(engine.connectCalls).toHaveLength(1);
      const sessionBefore = engine.sessionFor('libera');

      // Flip identity. Connections must persist; getMe() now fires.
      bloc.setIdentity({ guestNick: null });
      await flushPromises(4);
      expect(directory.getMe).toHaveBeenCalled();
      expect(bloc.getState().me?.id).toBe('u1');
      expect(bloc.getState().me?.handle).toBe('alice');

      // Same engine session — never torn down or replaced.
      expect(engine.sessionFor('libera')).toBe(sessionBefore);
      expect(sessionBefore.disconnectCalls).toBe(0);
      expect(bloc.getState().connections).toHaveLength(1);

      // No additional engine.connect — the live session was adopted, not
      // re-issued. This is the bug-fix observable: previously the new bloc
      // tried to re-connect and the engine 405'd.
      expect(engine.connectCalls).toHaveLength(1);
      bloc.dispose();
    });

    it('account → guest: synthesises me from the new nick without touching connections', async () => {
      const sessionStore = new SessionStore(memoryStorage());
      const engine = fakeEngine();
      const server = fakeServer('s1');
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(),
        directory,
        identity: fakeIdentity({ unlocked: true }),
        engine: engine.client,
        sessionStore,
      });
      await flushPromises(4);
      await bloc.connect(server);
      await flushPromises(2);

      bloc.setIdentity({ guestNick: 'visitor' });
      expect(bloc.getState().me?.id).toBe('__guest__');
      expect(bloc.getState().me?.handle).toBe('visitor');
      // Connections still live, no new connect issued.
      expect(bloc.getState().connections).toHaveLength(1);
      expect(engine.connectCalls).toHaveLength(1);
      expect(engine.sessionFor('s1').disconnectCalls).toBe(0);
      bloc.dispose();
    });

    it('is a no-op when the guestNick is unchanged', async () => {
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(),
        directory,
        identity: fakeIdentity(),
        engine: null,
        sessionStore: new SessionStore(memoryStorage()),
        guestNick: 'g1',
      });
      await flushPromises(4);
      const getMeCallsBefore = (directory.getMe as ReturnType<typeof vi.fn>).mock.calls.length;

      bloc.setIdentity({ guestNick: 'g1' });
      await flushPromises(2);
      // No backend churn for an identical identity — this is the path the
      // DirectoryScreen useEffect takes on first render, when guestNick is
      // already in sync with what the constructor used.
      expect((directory.getMe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(getMeCallsBefore);
      bloc.dispose();
    });
  });
});
