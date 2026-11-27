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
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from '../../modules/chat/services-credentials';
import { loadLocalServers } from '../../modules/directory/local-servers';
import { SecureBouncerStore, setBouncerStore, type BouncerProfile } from '../../modules/chat/bouncer.store';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import { NetworkDirectories } from '../../modules/directory/networks';
import { DirectorySources } from '../../modules/directory/sources';
import {
  fakeDirectory as fakeNetworkDirectory, fakeTransport, type FakeNetwork,
} from '../../modules/directory/test-directory-server';

// A bouncer store that hydrates instantly (tiny probe window) so connectWith's
// `await whenHydrated()` doesn't stall on the default 3s keychain poll.
async function fastBouncerStore(profile?: BouncerProfile): Promise<SecureBouncerStore> {
  const s = new SecureBouncerStore(new InMemorySecureStorage(), { probeIntervalMs: 1, probeTimeoutMs: 5 });
  await s.whenHydrated();
  if (profile) s.set(profile);
  return s;
}

// Use the synchronous (no-whenHydrated) creds store so connectWith doesn't
// block on the lazily-constructed secure default's hydration poll.
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

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
  nickservIdentifyCalls: string[] = [];
  rawCalls: string[] = [];
  listCalls = 0;
  disconnectCalls = 0;
  disposed_ = false;
  private stateListeners = new Set<StateListener>();
  private eventListeners = new Set<EventListener>();
  private channelDirectoryListeners = new Set<(entries: { name: string; userCount: number; topic: string }[]) => void>();
  private servicesListeners = new Set<(fw: 'atheme' | 'anope' | 'ergo' | 'unknown') => void>();
  private servicesFramework_: 'atheme' | 'anope' | 'ergo' | 'unknown' | null = null;
  private bouncerUpstreamListeners = new Set<(s: 'connected' | 'disconnected' | 'connecting') => void>();
  private bouncerUpstream_: 'connected' | 'disconnected' | 'connecting' | null = null;
  bouncerConnectCalls = 0;
  bouncerDisconnectCalls = 0;

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
  onServicesFramework(fn: (fw: 'atheme' | 'anope' | 'ergo' | 'unknown') => void): () => void {
    this.servicesListeners.add(fn);
    if (this.servicesFramework_ !== null) fn(this.servicesFramework_);
    return () => { this.servicesListeners.delete(fn); };
  }
  servicesFramework(): 'atheme' | 'anope' | 'ergo' | 'unknown' | null { return this.servicesFramework_; }
  onBouncerUpstream(fn: (s: 'connected' | 'disconnected' | 'connecting') => void): () => void {
    this.bouncerUpstreamListeners.add(fn);
    if (this.bouncerUpstream_ !== null) fn(this.bouncerUpstream_);
    return () => { this.bouncerUpstreamListeners.delete(fn); };
  }
  bouncerUpstream(): 'connected' | 'disconnected' | 'connecting' | null { return this.bouncerUpstream_; }
  bouncerConnect(): void { this.bouncerConnectCalls++; }
  bouncerDisconnect(): void { this.bouncerDisconnectCalls++; }
  join(channel: string): void { this.joinCalls.push(channel); }
  part(channel: string): void { this.partCalls.push(channel); }
  privmsg(target: string, message: string): void { this.privmsgCalls.push({ target, message }); }
  names(channel: string): void { this.namesCalls.push(channel); }
  tagmsg(target: string, tags: Record<string, string>): void { this.tagmsgCalls.push({ target, tags }); }
  list(): void { this.listCalls++; }
  disconnect(): void { this.disconnectCalls++; }
  nickservIdentify(password: string): void { this.nickservIdentifyCalls.push(password); }
  raw(line: string): void { this.rawCalls.push(line); }
  nickCalls: string[] = [];
  nick(n: string): void { this.nickCalls.push(n); }
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
  _emitServicesFramework(fw: 'atheme' | 'anope' | 'ergo' | 'unknown'): void {
    this.servicesFramework_ = fw;
    this.servicesListeners.forEach((fn) => fn(fw));
  }
  _emitBouncerUpstream(s: 'connected' | 'disconnected' | 'connecting'): void {
    this.bouncerUpstream_ = s;
    this.bouncerUpstreamListeners.forEach((fn) => fn(s));
  }
  _dispose(): void {
    this.disposed_ = true;
    this.eventListeners.clear();
    this.stateListeners.clear();
    this.channelDirectoryListeners.clear();
    this.servicesListeners.clear();
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
    probe: () => {},
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
  const find = (id: string) => opts.servers?.find((s) => s.id === id) ?? fakeServer(id);
  return {
    getMe: vi.fn(async () => opts.user ?? null),
    listServers: opts.list ?? (vi.fn(async () => opts.servers ?? [])),
    setupMe: vi.fn(),
    deleteMe: vi.fn(),
    getSavedSession: vi.fn(async () => null),
    putSavedSession: vi.fn(async () => undefined),
    uploadServerImage: vi.fn(async (id: string, _kind: string, _img: Blob) => ({ ...find(id), icon_url: 'https://cdn/i.png' })),
    deleteServerImage: vi.fn(async (id: string) => ({ ...find(id), icon_url: undefined })),
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
  beforeEach(async () => {
    vi.useRealTimers();
    setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
    // Empty, instantly-hydrated bouncer store so connectWith doesn't poll the
    // (unavailable) keychain for 3s and connects stay direct by default.
    setBouncerStore(await fastBouncerStore());
  });
  afterEach(() => { vi.useRealTimers(); });

  describe('startup loads that fail are retried (no relaunch needed)', () => {
    const offline = () => Object.assign(new Error('connection refused'), { status: 0 });

    it('retries /me until it answers, then clears the error', async () => {
      vi.useFakeTimers();
      const dir = fakeDirectory({ user: fakeUser(), servers: [fakeServer('a')] });
      (dir.getMe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(offline()).mockRejectedValueOnce(offline());
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory: dir, identity: fakeIdentity(), engine: null,
        sessionStore: new SessionStore(memoryStorage()),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bloc.getState().me).toBeUndefined();
      expect(bloc.getState().error).toBe('connection refused');
      await vi.advanceTimersByTimeAsync(1_000); // 1st retry: fails again
      expect(dir.getMe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000); // 2nd retry (backoff doubled): answers
      expect(dir.getMe).toHaveBeenCalledTimes(3);
      expect(bloc.getState().me?.handle).toBe(fakeUser().handle);
      expect(bloc.getState().error).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000); // and stops
      expect(dir.getMe).toHaveBeenCalledTimes(3);
      bloc.dispose();
    });

    it('a failed /me/session is fetched again and adopted; sync starts only after', async () => {
      vi.useFakeTimers();
      const dir = fakeDirectory({ user: fakeUser(), servers: [] });
      const remote = { version: 2, servers: [], activeServerId: null };
      (dir.getSavedSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(offline()).mockResolvedValue(remote);
      const store = new SessionStore(memoryStorage());
      const saveSilent = vi.spyOn(store, 'saveSilent');
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory: dir, identity: fakeIdentity(), engine: null, sessionStore: store,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bloc.getState().me?.handle).toBe(fakeUser().handle); // profile still applies
      expect(saveSilent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dir.getSavedSession).toHaveBeenCalledTimes(2);
      expect(saveSilent).toHaveBeenCalledWith(remote);
      expect(dir.getMe).toHaveBeenCalledTimes(1); // not re-fetched
      bloc.dispose();
    });

    it('synced preferences: a newer copy is applied live; a change here goes up with the servers', async () => {
      vi.useFakeTimers();
      localStorage.clear();
      const { __resetNotificationSettingsCache, getNotificationSettings, getServerLevels, setServerLevels } = await import('../../modules/ui/notifications.store');
      __resetNotificationSettingsCache();
      const dir = fakeDirectory({ user: fakeUser(), servers: [] });
      const remote = {
        servers: [], activeServerId: null,
        prefs: { updatedAt: Date.now() - 1000, values: {
          'boson:notifications:v1': JSON.stringify({ sound: false }),
          'boson:notifications:servers:v1': JSON.stringify({ s1: { channels: 'all' } }),
        } },
      };
      (dir.getSavedSession as ReturnType<typeof vi.fn>).mockResolvedValue(remote);
      const store = new SessionStore(memoryStorage());
      const saveSilent = vi.spyOn(store, 'saveSilent');
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory: dir, identity: fakeIdentity(), engine: null, sessionStore: store,
      });
      await vi.advanceTimersByTimeAsync(0);
      // The servers part is the saved session; the preferences apply.
      expect(saveSilent).toHaveBeenCalledWith({ servers: [], activeServerId: null });
      expect(getNotificationSettings().sound).toBe(false);
      expect(getServerLevels('s1').channels).toBe('all');
      expect(dir.putSavedSession).not.toHaveBeenCalled(); // taking it isn't a change
      // A change here: pushed (debounced) with the servers.
      setServerLevels('s1', { dms: 'nothing' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dir.putSavedSession).toHaveBeenCalledTimes(1);
      const sent = (dir.putSavedSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { prefs: { updatedAt: number; values: Record<string, string> } };
      expect(JSON.parse(sent.prefs.values['boson:notifications:servers:v1']!)).toEqual({ s1: { channels: 'all', dms: 'nothing' } });
      expect(sent.prefs.updatedAt).toBeGreaterThan(remote.prefs.updatedAt);
      bloc.dispose();
      localStorage.clear();
      __resetNotificationSettingsCache();
    });

    it('a failed directory list is fetched again', async () => {
      vi.useFakeTimers();
      const list = vi.fn(async () => [fakeServer('a')]);
      list.mockRejectedValueOnce(offline());
      const dir = fakeDirectory({ user: fakeUser(), list: list as unknown as DirectoryService['listServers'] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory: dir, identity: fakeIdentity(), engine: null,
        sessionStore: new SessionStore(memoryStorage()),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bloc.getState().servers).toEqual([]);
      expect(bloc.getState().error).toBe('connection refused');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(bloc.getState().servers?.map((s) => s.id)).toEqual(['a']);
      expect(bloc.getState().error).toBeNull();
      bloc.dispose();
    });

    it('the network coming back retries at once', async () => {
      vi.useFakeTimers();
      const dir = fakeDirectory({ user: fakeUser(), servers: [] });
      (dir.getMe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(offline()).mockRejectedValueOnce(offline());
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory: dir, identity: fakeIdentity(), engine: null,
        sessionStore: new SessionStore(memoryStorage()),
      });
      await vi.advanceTimersByTimeAsync(1_000); // retries once (fails), next in 2s
      expect(dir.getMe).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
      expect(dir.getMe).toHaveBeenCalledTimes(3);
      expect(bloc.getState().me?.handle).toBe(fakeUser().handle);
      bloc.dispose();
    });
  });

  it('setServerImage uploads + refreshes the row in state', async () => {
    const dir = fakeDirectory({ user: fakeUser(), servers: [fakeServer('a')] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: dir,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await vi.waitFor(() => expect(bloc.getState().servers).not.toBeNull());
    await bloc.setServerImage('a', 'icon', new Blob(['x']));
    expect(dir.uploadServerImage).toHaveBeenCalledWith('a', 'icon', expect.anything());
    expect(bloc.getState().servers?.find((s) => s.id === 'a')?.icon_url).toBe('https://cdn/i.png');
  });

  it('setServerImage(null) removes + refreshes the row', async () => {
    const dir = fakeDirectory({ user: fakeUser(), servers: [fakeServer('a')] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: dir,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises();
    await bloc.setServerImage('a', 'banner', null);
    expect(dir.deleteServerImage).toHaveBeenCalledWith('a', 'banner');
  });

  it('setServerImage(null) clears the removed image from the loaded row', async () => {
    const dir = fakeDirectory({ user: fakeUser(), servers: [fakeServer('a', { icon_url: 'https://cdn/old.png' })] });
    (dir.deleteServerImage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeServer('a'));
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: dir,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(bloc.getState().servers?.find((s) => s.id === 'a')?.icon_url).toBe('https://cdn/old.png');
    await bloc.setServerImage('a', 'icon', null);
    expect(bloc.getState().servers?.find((s) => s.id === 'a')?.icon_url).toBeUndefined();
    bloc.dispose();
  });

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

  it('restores the saved session without waiting for the directory list', async () => {
    const sessionStore = new SessionStore(memoryStorage());
    sessionStore.upsertServer({ id: 'libera', name: 'Libera', hostname: 'irc.libera.chat', port: 6697, tls: true });
    const engine = fakeEngine();
    // The directory never answers.
    const listServers = vi.fn(() => new Promise<never>(() => {})) as unknown as DirectoryService['listServers'];
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser('alice'), list: listServers }),
      identity: fakeIdentity(),
      engine: engine.client,
      sessionStore,
    });
    await flushPromises(6);
    expect(engine.connectCalls.map((c) => c.serverId)).toEqual(['libera']);
    expect(bloc.getState().servers).toBeNull();
    bloc.dispose();
  });

  it('flags `searching` while a refetch is in flight', async () => {
    let resolve!: (v: Awaited<ReturnType<DirectoryService['listServers']>>) => void;
    const listServers = vi.fn(async () => [fakeServer('libera')]) as unknown as DirectoryService['listServers'];
    const directory = fakeDirectory({ user: fakeUser(), list: listServers });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    expect(bloc.getState().searching).toBe(false);

    (listServers as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((r) => { resolve = r; }),
    );
    bloc.refreshDirectory();
    expect(bloc.getState().searching).toBe(true);
    // Existing results stay on screen during the refetch.
    expect(bloc.getState().servers).not.toBeNull();

    resolve([fakeServer('oftc')]);
    await flushPromises();
    expect(bloc.getState().searching).toBe(false);
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

  it('setShowNsfw refetches with nsfw=true (the backend omits NSFW rows otherwise)', async () => {
    const safe = fakeServer('safe', { is_nsfw: false });
    const naughty = fakeServer('naughty', { is_nsfw: true });
    // Like the real backend: NSFW rows only when asked for.
    const listServers = vi.fn(async (p?: { nsfw?: boolean }) => (p?.nsfw ? [safe, naughty] : [safe]));
    const directory = fakeDirectory({ user: fakeUser(), list: listServers as unknown as DirectoryService['listServers'] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    bloc.setQuery('x');
    bloc.setShowNsfw(true);
    await flushPromises(4);
    expect(listServers.mock.calls.at(-1)?.[0]).toEqual({ q: 'x', nsfw: true });
    expect(bloc.getState().filteredServers?.map((s) => s.id)).toEqual(['safe', 'naughty']);

    bloc.setShowNsfw(false);
    await flushPromises(4);
    expect(listServers.mock.calls.at(-1)?.[0]).toEqual({ q: 'x' });
    expect(bloc.getState().filteredServers?.map((s) => s.id)).toEqual(['safe']);
    bloc.dispose();
  });

  it('a successful refetch clears an earlier list error', async () => {
    const listServers = vi.fn(async () => { throw new Error('backend down'); });
    const directory = fakeDirectory({ user: fakeUser(), list: listServers as unknown as DirectoryService['listServers'] });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory,
      identity: fakeIdentity(),
      engine: null,
      sessionStore: new SessionStore(memoryStorage()),
      guestNick: 'guest',
    });
    await flushPromises(4);
    expect(bloc.getState().error).toBe('backend down');

    listServers.mockImplementation(async () => [fakeServer('libera')] as never);
    bloc.refreshDirectory();
    await flushPromises(4);
    expect(bloc.getState().servers?.map((s) => s.id)).toEqual(['libera']);
    expect(bloc.getState().error).toBeNull();
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

  describe('manual server connection options', () => {
    // Local servers persist to the window's localStorage (not the injected
    // session store), so clear the key to keep tests independent.
    beforeEach(() => { localStorage.removeItem('boson:local-servers:v1'); });

    it('addLocalServer writes secrets to the credentials store and tlsInsecure to the local record', async () => {
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity({ unlocked: true }),
        engine: fakeEngine().client, sessionStore: new SessionStore(memoryStorage()),
      });
      await flushPromises(4);

      const created = bloc.addLocalServer({
        name: 'Private', hostname: 'irc.private.test', port: 6697, tls: true,
        tlsInsecure: true,
        serverPass: 'srv-pw',
        sasl: { user: 'alice', password: 'sasl-pw' },
        nickservPassword: 'ns-pw',
      });

      // Secrets land in the keychain-backed cred store, never the local record.
      const creds = getServiceCredentialsStore().get(created.id);
      expect(creds?.serverPass).toBe('srv-pw');
      expect(creds?.sasl).toEqual({ user: 'alice', password: 'sasl-pw' });
      expect(creds?.nickservPassword).toBe('ns-pw');
      // Non-secret tlsInsecure lives on the local-server record.
      const rec = loadLocalServers().find((s) => s.id === created.id);
      expect(rec?.tlsInsecure).toBe(true);
      expect((rec as Record<string, unknown> | undefined)?.serverPass).toBeUndefined();
      bloc.dispose();
    });

    it('guest mode with the backend unreachable still lists locally-added servers', async () => {
      const directory = fakeDirectory({
        list: vi.fn(async () => { throw new TypeError('fetch failed'); }),
      });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity({ unlocked: false }),
        engine: fakeEngine().client, sessionStore: new SessionStore(memoryStorage()),
        guestNick: 'offline-guest',
      });
      await flushPromises(4);

      // The error is surfaced, but the directory isn't stuck "loading" and the
      // guest identity is synthesised (session restore needs me.handle).
      expect(bloc.getState().error).toBe('fetch failed');
      expect(bloc.getState().filteredServers).toEqual([]);
      expect(bloc.getState().me?.handle).toBe('offline-guest');

      const created = bloc.addLocalServer({ name: 'LAN', hostname: '192.168.1.42', port: 6667, tls: false });
      expect(bloc.getState().filteredServers?.map((s) => s.id)).toEqual([created.id]);
      bloc.dispose();
    });

    it('connect() forwards the manual server password, SASL, and tlsInsecure to the engine', async () => {
      const engine = fakeEngine();
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity({ unlocked: true }),
        engine: engine.client, sessionStore: new SessionStore(memoryStorage()),
      });
      await flushPromises(4);

      const created = bloc.addLocalServer({
        name: 'Private', hostname: 'irc.private.test', port: 6697, tls: true,
        tlsInsecure: true, serverPass: 'srv-pw',
        sasl: { user: 'alice', password: 'sasl-pw' }, nickservPassword: 'ns-pw',
      });
      await bloc.connect(fakeServer(created.id, { hostname: 'irc.private.test', port: 6697, tls: true }));
      await flushPromises(2);

      const call = engine.connectCalls[0]!;
      expect(call.serverPass).toBe('srv-pw');
      expect(call.sasl).toEqual({ user: 'alice', password: 'sasl-pw' });
      expect(call.nickservPassword).toBe('ns-pw');
      expect(call.tlsInsecure).toBe(true);
      bloc.dispose();
    });

    it('connect() to an ordinary directory server sends no manual auth', async () => {
      const engine = fakeEngine();
      const server = fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true });
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity({ unlocked: true }),
        engine: engine.client, sessionStore: new SessionStore(memoryStorage()),
      });
      await flushPromises(4);
      await bloc.connect(server);
      await flushPromises(2);

      const call = engine.connectCalls[0]!;
      expect(call.serverPass).toBeUndefined();
      expect(call.sasl).toBeUndefined();
      expect(call.tlsInsecure).toBeUndefined();
      bloc.dispose();
    });
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

  it("signOut() really disconnects (no adoption by the next account) and doesn't sync the cleared session to the account", async () => {
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser(), servers: [server] });
    const sessionStore = new SessionStore(memoryStorage());
    const auth = fakeAuth();
    const bloc = new DirectoryBloc({ auth, directory, identity: fakeIdentity(), engine: engine.client, sessionStore });
    await flushPromises(4);
    await bloc.connect(server);
    engine.sessionFor('s1')._setState('connected');
    // The saved-session sync is live and has pushed s1.
    await vi.waitFor(() => expect(directory.putSavedSession).toHaveBeenCalled(), { timeout: 2000 });
    const pushes = (directory.putSavedSession as ReturnType<typeof vi.fn>).mock.calls.length;

    await bloc.signOut();
    expect(engine.sessionFor('s1').disconnectCalls).toBe(1);
    expect(sessionStore.load()).toBeNull();
    expect(auth.signOut).toHaveBeenCalled();
    // Past the sync's debounce: the wipe never reached /me/session.
    await new Promise((r) => setTimeout(r, 900));
    expect((directory.putSavedSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(pushes);
    bloc.dispose();
  });

  it('a handle renamed in Settings renames the nick on connected servers right away', async () => {
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser(), servers: [server] });
    const bloc = new DirectoryBloc({ auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore: new SessionStore(memoryStorage()) });
    await flushPromises(4);
    await bloc.connect(server);
    engine.sessionFor('s1')._setState('connected');
    const handle = bloc.getState().me!.handle;
    bloc.setHandle(`${handle}2`);
    expect(engine.sessionFor('s1').nickCalls).toEqual([`${handle}2`]);
    expect(bloc.getState().me!.handle).toBe(`${handle}2`);
    bloc.dispose();
  });

  it('the nick picked on a server is asked for on the next connect; a handle rename is not a pick', async () => {
    localStorage.removeItem('boson:server-nick:v1');
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser(), servers: [server] });
    const bloc = new DirectoryBloc({ auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore: new SessionStore(memoryStorage()) });
    await flushPromises(4);
    await bloc.connect(server);
    const s1 = engine.sessionFor('s1');
    s1._setState('connected');
    const handle = bloc.getState().me!.handle;
    const first = engine.connectCalls[0]!.nick;
    s1._emitEvent({ Kind: '001', From: 'srv', Target: first, Message: 'Welcome', Raw: '' });
    // following a new handle: not remembered
    bloc.setHandle(`${handle}2`);
    s1._emitEvent({ Kind: 'NICK', From: first, Target: '', Message: s1.nickCalls[0]!, Raw: '' });
    expect(localStorage.getItem('boson:server-nick:v1')).toBeNull();
    // the user's /nick, answered: remembered for this server
    const conn = bloc.getState().connections[0]!;
    conn.chat.changeNick('TheLion');
    s1._emitEvent({ Kind: 'NICK', From: s1.nickCalls[0]!, Target: '', Message: 'TheLion', Raw: '' });
    bloc.disconnect('s1');
    await bloc.connect(server);
    expect(engine.connectCalls.at(-1)!.nick).toBe('TheLion');
    bloc.dispose();
    localStorage.removeItem('boson:server-nick:v1');
  });

  it('device B, fresh on a shared bouncer connection device A renamed, sends no NICK and saves the bouncer nick', async () => {
    localStorage.removeItem('boson:server-nick:v1');
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser(), servers: [server] });
    const bloc = new DirectoryBloc({ auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore: new SessionStore(memoryStorage()) });
    await flushPromises(4);
    await bloc.connect(server);
    const s1 = engine.sessionFor('s1');
    s1._setState('connected');
    const handle = bloc.getState().me!.handle;
    // Nothing saved on this device: it registers with its default...
    const first = engine.connectCalls[0]!.nick;
    // ...and the bridge attaches it to the connection device A renamed.
    s1._emitEvent({ Kind: '001', From: 'srv', Target: 'TheLion', Message: 'Welcome', Raw: '' });
    s1._emitEvent({ Kind: 'NICK', From: first, Target: '', Message: 'TheLion', Raw: '' });
    // A new Boson handle doesn't rename the shared connection either.
    bloc.setHandle(`${handle}2`);
    expect(s1.nickCalls).toEqual([]);
    expect(bloc.getState().connections[0]!.chat.getState().myNick).toBe('TheLion');
    // Saved as this device's nick: the next connect registers with it.
    bloc.disconnect('s1');
    await bloc.connect(server);
    expect(engine.connectCalls.at(-1)!.nick).toBe('TheLion');
    bloc.dispose();
    localStorage.removeItem('boson:server-nick:v1');
  });

  it("a /nick the link dropped before answering is made on the next connection, and the bouncer's nick otherwise wins", async () => {
    localStorage.removeItem('boson:server-nick:v1');
    const engine = fakeEngine();
    const server = fakeServer('s1');
    const directory = fakeDirectory({ user: fakeUser(), servers: [server] });
    const bloc = new DirectoryBloc({ auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore: new SessionStore(memoryStorage()) });
    await flushPromises(4);
    await bloc.connect(server);
    const s1 = engine.sessionFor('s1');
    s1._setState('connected');
    s1._emitEvent({ Kind: '001', From: 'srv', Target: 'TheLion', Message: 'Welcome', Raw: '' });
    bloc.getState().connections[0]!.chat.changeNick('Lion');
    expect(s1.nickCalls).toEqual(['Lion']);
    // no answer: the link drops
    bloc.disconnect('s1');
    await bloc.connect(server);
    expect(engine.connectCalls.at(-1)!.nick).toBe('Lion');
    const s2 = engine.sessionFor('s1');
    s2._setState('connected');
    s2._emitEvent({ Kind: '001', From: 'srv', Target: 'TheLion', Message: 'Welcome', Raw: '' });
    expect(s2.nickCalls.at(-1)).toBe('Lion');
    s2._emitEvent({ Kind: 'NICK', From: 'TheLion', Target: '', Message: 'Lion', Raw: '' });
    expect(localStorage.getItem('boson:server-nick:v1')).toContain('Lion');
    bloc.dispose();
    localStorage.removeItem('boson:server-nick:v1');
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

  // Repro for "clicked Reconnect on the disconnected splash but my
  // channels weren't rejoined". The reconnect path re-uses `connect()`
  // which tears down the wedged Connection and mints a fresh one — but
  // the fresh one's `connected` callback only replays joins from
  // `pendingJoins`, which session-restore populates on cold boot. The
  // reconnect path now snapshots the channels from sessionStore before
  // teardown so the fresh session rejoins them on `connected`.
  it('reconnectActive() rejoins the saved channel set after a wedge', async () => {
    const sessionStore = new SessionStore(memoryStorage());
    const engine = fakeEngine();
    const server = fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true });
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

    // First connect + join two channels (simulating the user's normal
    // session before the network glitch).
    engine.sessionFor('libera')._setState('connected');
    await flushPromises(2);
    sessionStore.addChannel('libera', '#general');
    sessionStore.addChannel('libera', '#help');

    // Simulate a network drop — engine goes disconnected.
    engine.sessionFor('libera')._setState('disconnected');
    await flushPromises(2);

    // User clicks Reconnect.
    await bloc.reconnectActive();
    await flushPromises(2);

    // A second engine.connect was issued — the wedged session was
    // replaced. The new session is now in 'connecting' on the same id.
    expect(engine.connectCalls.length).toBeGreaterThanOrEqual(2);
    const reconnectSession = engine.sessionFor('libera');
    expect(reconnectSession.joinCalls).toEqual([]);

    // Drive the fresh session to connected — the saved channels should
    // replay automatically.
    reconnectSession._setState('connected');
    await flushPromises(4);
    expect(reconnectSession.joinCalls).toContain('#general');
    expect(reconnectSession.joinCalls).toContain('#help');
    bloc.dispose();
  });

  // A reconnect mints a fresh ChatService. What was on screen goes with it:
  // on a bouncer (no local history) it would otherwise vanish, since ZNC
  // only replays what nobody has seen yet. The replayed backlog then adds
  // what was missed without repeating what was already there.
  it('a reconnect keeps the conversations on screen and adds the backlog without repeats', async () => {
    const sessionStore = new SessionStore(memoryStorage());
    const engine = fakeEngine();
    const server = fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true });
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser('alice'), servers: [server] }),
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore,
    });
    await flushPromises(4);
    await bloc.connect(server);
    await flushPromises(2);
    const first = engine.sessionFor('libera');
    first._setState('connected');
    await flushPromises(2);
    const msg = (text: string, time: string): IrcEvent =>
      ({ Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: text, Tags: { time }, Raw: '' });
    const dm = (text: string, time: string): IrcEvent =>
      ({ Kind: 'PRIVMSG', From: 'bob', Target: 'alice', Message: text, Tags: { time }, Raw: '' });
    first._emitEvent({ Kind: 'JOIN', From: 'alice', Target: '#general', Message: '', Raw: '' });
    first._emitEvent(msg('read before the drop', '2026-10-12T09:00:00.000Z'));
    first._emitEvent(dm('a private line', '2026-10-12T09:01:00.000Z'));

    first._setState('disconnected');
    await flushPromises(2);
    await bloc.reconnectActive();
    await flushPromises(2);
    const conn = bloc.getState().connections[0]!;
    const texts = (name: string) =>
      conn.chat.getState().channels.find((c) => c.name === name)?.messages.map((m) => m.text) ?? [];
    expect(texts('#general')).toContain('read before the drop');
    expect(texts('bob')).toEqual(['a private line']);
    // Still open on the same channel, not back to the splash.
    expect(conn.chat.getState().activeChannel).toBe('#general');

    // The bouncer replays: one line already shown, one missed.
    const again = engine.sessionFor('libera');
    again._setState('connected');
    await flushPromises(2);
    again._emitEvent({ Kind: 'JOIN', From: 'alice', Target: '#general', Message: '', Raw: '' });
    again._emitEvent(msg('read before the drop', '2026-10-12T09:00:00.000Z'));
    again._emitEvent(msg('said during the drop', '2026-10-12T09:05:00.000Z'));
    const after = texts('#general');
    expect(after.filter((t) => t === 'read before the drop')).toHaveLength(1);
    expect(after.indexOf('read before the drop')).toBeLessThan(after.indexOf('said during the drop'));
    bloc.dispose();
  });

  // Server settings → Actions → Reconnect on a LIVE connection used to be a
  // no-op: connect()'s same-server guard just switched to it.
  it('reconnectActive() on a connected server quits it and rejoins on a fresh session', async () => {
    const sessionStore = new SessionStore(memoryStorage());
    const engine = fakeEngine();
    const server = fakeServer('libera');
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
    const first = engine.sessionFor('libera');
    first._setState('connected');
    await flushPromises(2);
    sessionStore.addChannel('libera', '#general');

    const done = bloc.reconnectActive();
    await flushPromises(4);
    expect(first.disconnectCalls).toBe(1);
    // Like the real engine client: the old session is only dropped once the
    // engine echoes `disconnected`; until then no new connect goes out.
    expect(engine.connectCalls).toHaveLength(1);
    first._setState('disconnected');
    engine.sessions.delete('libera');
    first._dispose();
    await done;

    expect(engine.connectCalls).toHaveLength(2);
    const fresh = engine.sessionFor('libera');
    expect(fresh).not.toBe(first);
    expect(bloc.getState().connections.map((c) => c.serverId)).toEqual(['libera']);
    fresh._setState('connected');
    await flushPromises(4);
    expect(fresh.joinCalls).toContain('#general');
    // The deliberate quit didn't arm auto-reconnect.
    expect(bloc.getState().connections[0]?.reconnect.active).toBe(false);
    bloc.dispose();
  });

  describe('active server', () => {
    function twoServers() {
      const sessionStore = new SessionStore(memoryStorage());
      const engine = fakeEngine();
      const a = fakeServer('a');
      const b = fakeServer('b');
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [a, b] });
      return { sessionStore, engine, a, b, directory };
    }

    it('restoring several servers keeps the saved active one (the last to connect does not steal it)', async () => {
      const { sessionStore, engine, directory } = twoServers();
      sessionStore.save({
        servers: [
          { server: { id: 'a', name: 'a', hostname: 'irc.a', port: 6697, tls: true }, channels: [], activeChannel: null },
          { server: { id: 'b', name: 'b', hostname: 'irc.b', port: 6697, tls: true }, channels: [], activeChannel: null },
        ],
        activeServerId: 'a',
      });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity({ unlocked: true }), engine: engine.client, sessionStore,
      });
      await flushPromises(20);
      expect(engine.connectCalls.map((c) => c.serverId)).toEqual(['a', 'b']);
      expect(bloc.getState().activeServerId).toBe('a');
      expect(sessionStore.load()?.activeServerId).toBe('a');
      bloc.dispose();
    });

    it('connecting a server makes it the active one, also for the next launch', async () => {
      const { sessionStore, engine, directory, a, b } = twoServers();
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity({ unlocked: true }), engine: engine.client, sessionStore,
      });
      await flushPromises(4);
      await bloc.connect(a);
      await bloc.connect(b);
      expect(bloc.getState().activeServerId).toBe('b');
      expect(sessionStore.load()?.activeServerId).toBe('b');
      bloc.dispose();
    });

    it('a background server auto-reconnecting does not take focus', async () => {
      vi.useFakeTimers();
      const { sessionStore, engine, directory, a, b } = twoServers();
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity({ unlocked: true }), engine: engine.client, sessionStore,
      });
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(a);
      engine.sessionFor('a')._setState('connected');
      await bloc.connect(b);
      engine.sessionFor('b')._setState('connected');
      bloc.setActiveServer('b');
      await vi.advanceTimersByTimeAsync(0);

      // A drops in the background and auto-reconnects after the backoff.
      const calls = engine.connectCalls.length;
      engine.sessionFor('a')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.connectCalls.length).toBe(calls + 1);
      expect(bloc.getState().activeServerId).toBe('b');
      expect(sessionStore.load()?.activeServerId).toBe('b');
      bloc.dispose();
      vi.useRealTimers();
    });
  });

  describe('auto-reconnect', () => {
    // Helper: spin up a bloc with one server already in the saved set so
    // `pendingJoins` gets seeded with the saved channels during the
    // reconnect-cycle's wedged-connection branch (verifies the join
    // replay still works hand-in-hand with auto-reconnect).
    function setup(channelsInSavedSet: string[] = ['#general']) {
      const sessionStore = new SessionStore(memoryStorage());
      const engine = fakeEngine();
      const server = fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true });
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(),
        directory,
        identity: fakeIdentity({ unlocked: true }),
        engine: engine.client,
        sessionStore,
      });
      // Pre-seed the saved channel set as if the user had joined them.
      sessionStore.upsertServer({
        id: 'libera', name: 'libera', hostname: 'irc.libera.chat', port: 6697, tls: true,
      });
      for (const ch of channelsInSavedSet) sessionStore.addChannel('libera', ch);
      return { bloc, engine, sessionStore, server };
    }

    it('schedules an auto-reconnect attempt after the engine drops', async () => {
      vi.useFakeTimers();
      const { bloc, engine, server } = setup();
      // Run through initial loadInitial + first connect.
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(server);
      await vi.advanceTimersByTimeAsync(0);

      // Successful connect → cycle is dormant.
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);
      const callsBeforeDrop = engine.connectCalls.length;

      // Engine drops. The bloc should schedule a fresh attempt at the
      // first backoff step (1s).
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(0);
      const beforeState = bloc.getState();
      const beforeConn = beforeState.connections.find((c) => c.serverId === 'libera')!;
      expect(beforeConn.reconnect.active).toBe(true);
      expect(beforeConn.engineState).toBe('disconnected');
      expect(engine.connectCalls.length).toBe(callsBeforeDrop);

      // Advance past the 1s backoff — connect should re-fire.
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.connectCalls.length).toBe(callsBeforeDrop + 1);
      bloc.dispose();
      vi.useRealTimers();
    });

    it('uses exponential backoff for consecutive failures', async () => {
      vi.useFakeTimers();
      const { bloc, engine, server } = setup();
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(server);
      await vi.advanceTimersByTimeAsync(0);
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);
      const baseCalls = engine.connectCalls.length;

      // Drop → wait 1s → attempt fires.
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.connectCalls.length).toBe(baseCalls + 1);

      // Second drop without success → next backoff is 2s.
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(0);
      // 1s shouldn't be enough.
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.connectCalls.length).toBe(baseCalls + 1);
      // Past 2s → fires.
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.connectCalls.length).toBe(baseCalls + 2);
      bloc.dispose();
      vi.useRealTimers();
    });

    it('cancelReconnectActive() halts the cycle and prevents future auto-arms', async () => {
      vi.useFakeTimers();
      const { bloc, engine, server } = setup();
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(server);
      await vi.advanceTimersByTimeAsync(0);
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);
      const baseCalls = engine.connectCalls.length;

      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(0);
      expect(bloc.getState().connections[0]!.reconnect.active).toBe(true);

      bloc.cancelReconnectActive();
      await vi.advanceTimersByTimeAsync(0);
      expect(bloc.getState().connections[0]!.reconnect.active).toBe(false);

      // Even if the original backoff would have fired by now, no new
      // connect attempts should land — the cycle is stopped.
      await vi.advanceTimersByTimeAsync(20000);
      expect(engine.connectCalls.length).toBe(baseCalls);

      // And a fresh drop doesn't re-arm because the cancelled flag is
      // sticky until the user manually clicks Reconnect.
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(0);
      expect(bloc.getState().connections[0]!.reconnect.active).toBe(false);
      await vi.advanceTimersByTimeAsync(20000);
      expect(engine.connectCalls.length).toBe(baseCalls);
      bloc.dispose();
      vi.useRealTimers();
    });

    it('reconnectActive() clears the cancelled flag and fires an immediate attempt', async () => {
      vi.useFakeTimers();
      const { bloc, engine, server } = setup();
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(server);
      await vi.advanceTimersByTimeAsync(0);
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);
      const baseCalls = engine.connectCalls.length;

      engine.sessionFor('libera')._setState('disconnected');
      bloc.cancelReconnectActive();
      await vi.advanceTimersByTimeAsync(0);
      expect(bloc.getState().connections[0]!.reconnect.active).toBe(false);

      await bloc.reconnectActive();
      await vi.advanceTimersByTimeAsync(0);
      // Manual reconnect issued a fresh connect right away, and the
      // cancelled flag flipped back to false so future drops re-arm.
      expect(engine.connectCalls.length).toBe(baseCalls + 1);
      expect(bloc.getState().connections[0]!.reconnect.active).toBe(true);
      bloc.dispose();
      vi.useRealTimers();
    });

    it('reaching connected resets the attempt counter so the next drop starts at the lowest backoff', async () => {
      vi.useFakeTimers();
      const { bloc, engine, server } = setup();
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(server);
      await vi.advanceTimersByTimeAsync(0);
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);

      // Two consecutive failures push the backoff to 2s.
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(1000);
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(2000);

      // Now succeed — counter resets.
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);
      const calls = engine.connectCalls.length;

      // Next drop should fire after just 1s, not 4s.
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.connectCalls.length).toBe(calls + 1);
      bloc.dispose();
      vi.useRealTimers();
    });

    it('rejoins saved channels via pendingJoins on the auto-reconnect attempt', async () => {
      vi.useFakeTimers();
      const { bloc, engine, server } = setup(['#general', '#help']);
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(server);
      await vi.advanceTimersByTimeAsync(0);
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);

      // Drop → auto-reconnect timer → connect attempt → connected →
      // pendingJoins drained → join calls issued.
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(1000);
      const session = engine.sessionFor('libera');
      session._setState('connected');
      await vi.advanceTimersByTimeAsync(0);
      expect(session.joinCalls).toContain('#general');
      expect(session.joinCalls).toContain('#help');
      bloc.dispose();
      vi.useRealTimers();
    });

    describe('back in the foreground', () => {
      let visibility: DocumentVisibilityState = 'visible';
      beforeEach(() => {
        visibility = 'visible';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
      });
      afterEach(() => {
        delete (document as { visibilityState?: unknown }).visibilityState;
      });
      // Hidden for `ms` without any timer running, as when iOS suspends the
      // app: only the clock moves.
      const suspend = (ms: number): void => {
        visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        vi.setSystemTime(Date.now() + ms);
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      };

      it('probes the connections, and reconnects a dropped server without waiting out its backoff', async () => {
        vi.useFakeTimers();
        const { bloc, engine, server } = setup();
        const probe = vi.spyOn(engine.client, 'probe');
        await vi.advanceTimersByTimeAsync(0);
        await bloc.connect(server);
        await vi.advanceTimersByTimeAsync(0);
        engine.sessionFor('libera')._setState('connected');
        await vi.advanceTimersByTimeAsync(0);
        engine.sessionFor('libera')._setState('disconnected');
        await vi.advanceTimersByTimeAsync(0);
        const baseCalls = engine.connectCalls.length;

        suspend(60_000);
        await vi.advanceTimersByTimeAsync(0); // (connect is async; the 1s backoff hasn't run)
        expect(probe).toHaveBeenCalledOnce();
        expect(engine.connectCalls.length).toBe(baseCalls + 1);
        bloc.dispose();
        vi.useRealTimers();
      });

      it('retries once the probe has had time to drop a dead connection', async () => {
        vi.useFakeTimers();
        const { bloc, engine, server } = setup();
        await vi.advanceTimersByTimeAsync(0);
        await bloc.connect(server);
        await vi.advanceTimersByTimeAsync(0);
        engine.sessionFor('libera')._setState('connected');
        await vi.advanceTimersByTimeAsync(0);

        suspend(60_000);
        const baseCalls = engine.connectCalls.length;
        // The probe finds it dead: the engine reports the drop, and the
        // recheck brings it back ahead of the backoff's later steps.
        engine.sessionFor('libera')._setState('disconnected');
        await vi.advanceTimersByTimeAsync(5_500);
        expect(engine.connectCalls.length).toBeGreaterThan(baseCalls);
        bloc.dispose();
        vi.useRealTimers();
      });

      it('a network change (Wi-Fi to cellular) probes the connections at once', async () => {
        vi.useFakeTimers();
        const { bloc, engine, server } = setup();
        const probe = vi.spyOn(engine.client, 'probe');
        await vi.advanceTimersByTimeAsync(0);
        await bloc.connect(server);
        await vi.advanceTimersByTimeAsync(0);
        window.dispatchEvent(new CustomEvent('boson:network', { detail: { online: true } }));
        expect(probe).toHaveBeenCalledOnce();
        bloc.dispose();
        window.dispatchEvent(new CustomEvent('boson:network', { detail: { online: true } }));
        expect(probe).toHaveBeenCalledOnce();
        vi.useRealTimers();
      });

      it('a brief glance away does nothing', async () => {
        vi.useFakeTimers();
        const { bloc, engine, server } = setup();
        const probe = vi.spyOn(engine.client, 'probe');
        await vi.advanceTimersByTimeAsync(0);
        await bloc.connect(server);
        await vi.advanceTimersByTimeAsync(0);
        suspend(3_000);
        expect(probe).not.toHaveBeenCalled();
        bloc.dispose();
        vi.useRealTimers();
      });
    });

    it('dispose() cancels pending auto-reconnect timers', async () => {
      vi.useFakeTimers();
      const { bloc, engine, server } = setup();
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(server);
      await vi.advanceTimersByTimeAsync(0);
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);
      const baseCalls = engine.connectCalls.length;
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(0);

      bloc.dispose();
      await vi.advanceTimersByTimeAsync(20000);
      // No new connect attempts fired against the disposed bloc.
      expect(engine.connectCalls.length).toBe(baseCalls);
      vi.useRealTimers();
    });

    it('disconnect(serverId) cancels any pending auto-reconnect for that server', async () => {
      vi.useFakeTimers();
      const { bloc, engine, server } = setup();
      await vi.advanceTimersByTimeAsync(0);
      await bloc.connect(server);
      await vi.advanceTimersByTimeAsync(0);
      engine.sessionFor('libera')._setState('connected');
      await vi.advanceTimersByTimeAsync(0);
      const baseCalls = engine.connectCalls.length;
      engine.sessionFor('libera')._setState('disconnected');
      await vi.advanceTimersByTimeAsync(0);

      bloc.disconnect('libera');
      await vi.advanceTimersByTimeAsync(20000);
      // User explicitly disconnected → no resurrection attempts.
      expect(engine.connectCalls.length).toBe(baseCalls);
      bloc.dispose();
      vi.useRealTimers();
    });
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

  it('orders the rail by the saved server list, and reorderServers() changes and keeps it', async () => {
    const engine = fakeEngine();
    const a = fakeServer('a');
    const b = fakeServer('b', { hostname: 'irc.b' });
    const c = fakeServer('c', { hostname: 'irc.c' });
    const store = new SessionStore(memoryStorage());
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser('alice'), servers: [a, b, c] }),
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: store,
    });
    await flushPromises(4);
    await bloc.connect(a);
    await bloc.connect(b);
    await bloc.connect(c);
    await flushPromises(2);
    const order = (): string[] => bloc.getState().connections.map((x) => x.serverId);
    expect(order()).toEqual(['a', 'b', 'c']);

    bloc.reorderServers(['c', 'a', 'b']);
    expect(order()).toEqual(['c', 'a', 'b']);
    expect(store.load()!.servers.map((x) => x.server.id)).toEqual(['c', 'a', 'b']);

    // A reconnect re-adds the connection last in the map; the rail doesn't move.
    await bloc.disconnect('a');
    await bloc.connect(a);
    await flushPromises(2);
    expect(store.load()!.servers.map((x) => x.server.id)).toEqual(['c', 'b', 'a']);
    bloc.reorderServers(['c', 'a', 'b']);
    expect(order()).toEqual(['c', 'a', 'b']);
    bloc.dispose();
  });

  it('reorderChannels() saves the channel order per server, keeps it over a reconnect, and resets', async () => {
    const engine = fakeEngine();
    const a = fakeServer('a');
    const store = new SessionStore(memoryStorage());
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser('alice'), servers: [a] }),
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: store,
    });
    await flushPromises(4);
    await bloc.connect(a);
    await flushPromises(2);
    store.setChannels('a', ['#x', '#Y', '#z']);
    expect(bloc.channelOrder('a')).toBeUndefined();

    bloc.reorderChannels('a', ['#z', '#x', '#Y']);
    expect(bloc.channelOrder('a')).toEqual(['#z', '#x', '#y']);
    // Reordering again while #Y is still being rejoined keeps its place.
    bloc.reorderChannels('a', ['#x', '#z']);
    expect(bloc.channelOrder('a')).toEqual(['#x', '#z', '#y']);

    // Keyed by the saved server, not the connection: a reconnect (a fresh
    // session + ChatService) keeps it.
    engine.sessionFor('a')._setState('disconnected');
    await bloc.connect(a);
    await flushPromises(2);
    expect(engine.connectCalls).toHaveLength(2);
    expect(bloc.channelOrder('a')).toEqual(['#x', '#z', '#y']);

    bloc.resetChannelOrder('a');
    expect(bloc.channelOrder('a')).toBeUndefined();
    bloc.dispose();
  });

  it('reorderChannels() keeps a channel that is still waiting to join (e.g. for NickServ) in its place', async () => {
    const engine = fakeEngine();
    const a = fakeServer('a');
    const store = new SessionStore(memoryStorage());
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser('alice'), servers: [a] }),
      identity: fakeIdentity({ unlocked: true }),
      engine: engine.client,
      sessionStore: store,
    });
    await flushPromises(4);
    await bloc.connect(a);
    await flushPromises(2);
    // #members (first) is refused until we've identified; the user swaps
    // the two that are in the list meanwhile.
    store.setChannels('a', ['#members', '#x', '#z']);
    expect(bloc.defaultChannelOrder('a')).toEqual(['#members', '#x', '#z']);
    bloc.reorderChannels('a', ['#z', '#x']);
    expect(bloc.channelOrder('a')).toEqual(['#members', '#z', '#x']);
    // A channel the user leaves drops out of both.
    store.removeChannel('a', '#x');
    expect(bloc.channelOrder('a')).toEqual(['#members', '#z']);
    expect(bloc.defaultChannelOrder('a')).toEqual(['#members', '#z']);
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

  describe('bouncer routing', () => {
    const profile: BouncerProfile = {
      enabled: true, host: 'znc.host', port: 7000, tls: true,
      tlsInsecure: true, username: 'me', password: 'pw',
    };

    async function connectWithRoute(
      route: { route: boolean; network: string; autoConnect?: boolean } | null,
      bouncer: BouncerProfile | null,
    ) {
      const storage = memoryStorage();
      const sessionStore = new SessionStore(storage);
      sessionStore.upsertServer({ id: 'libera', name: 'Libera', hostname: 'irc.libera.chat', port: 6697, tls: true });
      if (route) sessionStore.setServerBouncer('libera', route);
      if (bouncer) setBouncerStore(await fastBouncerStore(bouncer));

      const engine = fakeEngine();
      const server = fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true });
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore,
      });
      await flushPromises(4);
      await bloc.connect(server);
      await flushPromises(2);
      bloc.dispose();
      return engine.connectCalls[0]!;
    }

    it('routes to the bouncer with PASS user/network:password when enabled + route on', async () => {
      const call = await connectWithRoute({ route: true, network: 'libera' }, profile);
      expect(call.hostname).toBe('znc.host');
      expect(call.port).toBe(7000);
      expect(call.tls).toBe(true);
      expect(call.tlsInsecure).toBe(true);
      expect(call.serverPass).toBe('me/libera:pw');
      // Flags the connection as a bouncer link; auto-connect defaults ON.
      expect(call.bouncer).toBe(true);
      expect(call.bouncerAutoConnect).toBe(true);
    });

    it('passes bouncerAutoConnect=false when the server opted out', async () => {
      const call = await connectWithRoute({ route: true, network: 'libera', autoConnect: false }, profile);
      expect(call.bouncer).toBe(true);
      expect(call.bouncerAutoConnect).toBe(false);
    });

    it('keeps flood control on unless the profile turns it off', async () => {
      const on = await connectWithRoute({ route: true, network: 'libera' }, profile);
      expect(on.bouncerNoFloodControl).toBeUndefined();
      const off = await connectWithRoute({ route: true, network: 'libera' }, { ...profile, floodControl: false });
      expect(off.bouncerNoFloodControl).toBe(true);
    });

    it('never drops flood control on a direct connection', async () => {
      const call = await connectWithRoute({ route: false, network: 'libera' }, { ...profile, floodControl: false });
      expect(call.bouncerNoFloodControl).toBeUndefined();
    });

    it('omits the /network when the network name is blank', async () => {
      const call = await connectWithRoute({ route: true, network: '' }, profile);
      expect(call.serverPass).toBe('me:pw');
    });

    it('connects directly when the per-server route is off', async () => {
      const call = await connectWithRoute({ route: false, network: 'libera' }, profile);
      expect(call.hostname).toBe('irc.libera.chat');
      expect(call.serverPass).toBeUndefined();
      expect(call.tlsInsecure).toBeUndefined();
      expect(call.bouncer).toBeUndefined();
      expect(call.bouncerAutoConnect).toBeUndefined();
    });

    it('connects directly when the global profile is disabled', async () => {
      const call = await connectWithRoute({ route: true, network: 'libera' }, { ...profile, enabled: false });
      expect(call.hostname).toBe('irc.libera.chat');
      expect(call.serverPass).toBeUndefined();
      expect(call.bouncer).toBeUndefined();
    });

    // Through a bouncer that already has its channel list, a saved channel
    // it doesn't replay was left from another client: forgotten, not joined
    // again (which would undo that part on every client and on the bouncer).
    it('forgets a saved channel the bouncer no longer has instead of rejoining it', async () => {
      const sessionStore = new SessionStore(memoryStorage());
      setBouncerStore(await fastBouncerStore(profile));
      sessionStore.upsertServer({ id: 'libera', name: 'Libera', hostname: 'irc.libera.chat', port: 6697, tls: true });
      sessionStore.setServerBouncer('libera', { route: true, network: 'libera' });
      sessionStore.setBouncerSeeded('libera'); // seeded on an earlier attach
      sessionStore.addChannel('libera', '#general');
      sessionStore.addChannel('libera', '#Parted');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const engine = fakeEngine();
        const server = fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true });
        const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
        const bloc = new DirectoryBloc({
          auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore,
        });
        await flushPromises(4);
        await bloc.connect(server);
        await flushPromises(2);
        const session = engine.sessionFor('libera');
        const nick = engine.connectCalls[0]!.nick;
        session._setState('connected');
        await flushPromises(4);
        session._emitBouncerUpstream('connected');
        session._emitEvent({ Kind: 'JOIN', From: nick, Target: '#general', Message: '', Raw: '' });
        await flushPromises(2);
        vi.advanceTimersByTime(5_000);
        expect(session.joinCalls).toEqual([]);
        expect(sessionStore.load()!.servers.find((s) => s.server.id === 'libera')!.channels).toEqual(['#general']);
        bloc.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    // Server settings → Bouncer says "reconnect to apply" — so Reconnect on
    // a LIVE connection must rebuild the IRC session (it used to just
    // re-select it) and pick up the route saved since, even though the
    // connection holds a snapshot of its saved row from connect time.
    it('reconnectActive() on a live connection rebuilds it with the route saved since', async () => {
      const sessionStore = new SessionStore(memoryStorage());
      setBouncerStore(await fastBouncerStore(profile));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const engine = fakeEngine();
      const server = fakeServer('libera', { hostname: 'irc.libera.chat', port: 6697, tls: true });
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [server] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore,
      });
      await flushPromises(4);
      await bloc.connect(server);
      await flushPromises(2);
      engine.sessionFor('libera')._setState('connected');
      await flushPromises(2);
      sessionStore.addChannel('libera', '#general');
      sessionStore.addChannel('libera', '#random');
      expect(engine.connectCalls[0]!.bouncer).toBeUndefined();

      // Route it through the bouncer with auto-connect off, then Reconnect.
      bloc.setServerBouncer('libera', { route: true, network: 'libera', autoConnect: false });
      const reconnect = bloc.reconnectActive();
      await flushPromises(2);
      const old = engine.sessionFor('libera');
      expect(old.disconnectCalls).toBe(1);
      // Waits for the engine to drop the old session before connecting.
      expect(engine.connectCalls).toHaveLength(1);
      old._setState('disconnected');
      await reconnect;
      await flushPromises(2);

      expect(engine.connectCalls).toHaveLength(2);
      const call = engine.connectCalls[1]!;
      expect(call.hostname).toBe('znc.host');
      expect(call.serverPass).toBe('me/libera:pw');
      expect(call.bouncer).toBe(true);
      expect(call.bouncerAutoConnect).toBe(false);
      // The tear-down was not a user disconnect: no auto-reconnect cycle,
      // the saved row stays, and its channels re-join on the new session.
      expect(bloc.getServerBouncer('libera')?.autoConnect).toBe(false);
      try {
        const fresh = engine.sessionFor('libera');
        fresh._setState('connected');
        await flushPromises(4);
        // Through a bouncer the restore waits until it is on the network…
        expect(fresh.joinCalls).toEqual([]);
        fresh._emitBouncerUpstream('connected');
        // …which replays the channels it is already in…
        fresh._emitEvent({ Kind: 'JOIN', From: call.nick, Target: '#general', Message: '', Raw: '' });
        await flushPromises(2);
        vi.advanceTimersByTime(3_000);
        expect(fresh.joinCalls).toEqual([]);
        // …and once its JOINs go quiet, joins only what is missing.
        vi.advanceTimersByTime(1_000);
        expect(fresh.joinCalls).toEqual(['#random']);
      } finally {
        vi.useRealTimers();
      }
      expect(engine.connectCalls).toHaveLength(2);
      bloc.dispose();
    });
  });

  describe('bouncer networks', () => {
    const profile: BouncerProfile = {
      enabled: true, host: 'znc.host', port: 7000, tls: true,
      tlsInsecure: false, username: 'me', password: 'pw',
    };

    async function makeBloc() {
      const storage = memoryStorage();
      const sessionStore = new SessionStore(storage);
      setBouncerStore(await fastBouncerStore(profile));
      const engine = fakeEngine();
      const directory = fakeDirectory({ user: fakeUser('alice'), servers: [] });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore,
      });
      await flushPromises(4);
      return { bloc, engine, sessionStore };
    }

    it('adds a bouncer network as a routed saved-session row', async () => {
      const { bloc, sessionStore } = await makeBloc();
      bloc.addBouncerNetwork({ name: 'Libera', network: 'libera' });

      const nets = bloc.bouncerNetworks();
      expect(nets).toHaveLength(1);
      expect(nets[0]!.name).toBe('Libera');
      expect(nets[0]!.bouncer).toEqual({ route: true, network: 'libera' });
      // Host snapshotted from the bouncer profile.
      expect(nets[0]!.hostname).toBe('znc.host');
      // Persisted to the synced session store.
      expect(sessionStore.load()!.servers.some((s) => s.server.bouncer?.network === 'libera')).toBe(true);
      bloc.dispose();
    });

    it('connects a bouncer network through the bouncer', async () => {
      const { bloc, engine } = await makeBloc();
      bloc.addBouncerNetwork({ name: 'Libera', network: 'libera' });
      const id = bloc.bouncerNetworks()[0]!.id;
      bloc.connectBouncerNetwork(id);
      await flushPromises(2);
      const call = engine.connectCalls[0]!;
      expect(call.hostname).toBe('znc.host');
      expect(call.serverPass).toBe('me/libera:pw');
      bloc.dispose();
    });

    it('surfaces bouncer upstream state on the connection + chat serverInfo', async () => {
      const { bloc, engine } = await makeBloc();
      bloc.addBouncerNetwork({ name: 'Libera', network: 'libera' });
      const id = bloc.bouncerNetworks()[0]!.id;
      bloc.connectBouncerNetwork(id);
      await flushPromises(2);
      const conn = () => bloc.getState().connections.find((c) => c.serverId === id)!;
      expect(conn().bouncerUpstream).toBeNull();

      const session = engine.sessionFor(id);
      session._setState('connected');
      session._emitBouncerUpstream('disconnected');
      expect(conn().bouncerUpstream).toBe('disconnected');
      expect(conn().chat.getState().serverInfo.bouncerUpstream).toBe('disconnected');
      expect(conn().chat.getState().serverInfo.bouncer).toBe(true);

      session._emitBouncerUpstream('connected');
      expect(conn().bouncerUpstream).toBe('connected');
      expect(conn().chat.getState().serverInfo.bouncerUpstream).toBe('connected');
      bloc.dispose();
    });

    it('bouncerConnect / bouncerDisconnect drive the live session; no-op for unknown ids', async () => {
      const { bloc, engine } = await makeBloc();
      bloc.addBouncerNetwork({ name: 'Libera', network: 'libera' });
      const id = bloc.bouncerNetworks()[0]!.id;
      bloc.connectBouncerNetwork(id);
      await flushPromises(2);
      const session = engine.sessionFor(id);
      bloc.bouncerConnect(id);
      bloc.bouncerDisconnect(id);
      expect(session.bouncerConnectCalls).toBe(1);
      expect(session.bouncerDisconnectCalls).toBe(1);
      expect(() => bloc.bouncerConnect('nope')).not.toThrow();
      bloc.dispose();
    });

    it('removes a bouncer network from the saved session', async () => {
      const { bloc } = await makeBloc();
      bloc.addBouncerNetwork({ name: 'Libera', network: 'libera' });
      const id = bloc.bouncerNetworks()[0]!.id;
      bloc.removeBouncerNetwork(id);
      expect(bloc.bouncerNetworks()).toHaveLength(0);
      bloc.dispose();
    });

    it('discovers networks by probing *status ListNetworks', async () => {
      const { bloc, engine } = await makeBloc();
      vi.useFakeTimers();
      try {
        const p = bloc.discoverBouncerNetworks();
        // The probe connection is opened synchronously inside the executor.
        const call = engine.connectCalls.find((c) => c.serverId === '__bouncer-probe__')!;
        expect(call).toBeDefined();
        expect(call.serverPass).toBe('me:pw'); // user:password, NO /network
        const probe = engine.sessionFor('__bouncer-probe__');

        // Welcome → probe sends the query; ZNC replies with a table.
        probe._emitEvent({ Kind: '001', From: 'znc', Target: 'me', Message: 'welcome', Raw: '' });
        expect(probe.privmsgCalls).toContainEqual({ target: '*status', message: 'ListNetworks' });
        for (const line of ['| Network | OnIRC |', '| libera | Yes |', '| oftc | No |']) {
          probe._emitEvent({ Kind: 'PRIVMSG', From: '*status', Target: 'me', Message: line, Raw: '' });
        }
        await vi.advanceTimersByTimeAsync(4000); // capture window elapses → resolve
        await expect(p).resolves.toEqual(['libera', 'oftc']);
        expect(probe.disconnectCalls).toBeGreaterThanOrEqual(1); // probe torn down
      } finally {
        vi.useRealTimers();
      }
      bloc.dispose();
    });

    it('asks a soju-style bouncer (soju, evrd) with BOUNCER LISTNETWORKS', async () => {
      const { bloc, engine } = await makeBloc();
      vi.useFakeTimers();
      try {
        const p = bloc.discoverBouncerNetworks();
        const call = engine.connectCalls.find((c) => c.serverId === '__bouncer-probe__')!;
        expect(call.bouncerNetworks).toBe(true);
        expect(call.serverPass).toBe('me:pw');
        const probe = engine.sessionFor('__bouncer-probe__');

        probe._emitEvent({ Kind: 'CAP', From: 'evrd', Target: '', Args: ['ACK', 'batch server-time soju.im/bouncer-networks'], Message: 'batch server-time soju.im/bouncer-networks', Raw: '' });
        probe._emitEvent({ Kind: '001', From: 'evrd', Target: 'me', Message: 'welcome', Raw: '' });
        expect(probe.rawCalls).toContain('BOUNCER LISTNETWORKS');
        expect(probe.privmsgCalls).not.toContainEqual({ target: '*status', message: 'ListNetworks' });

        probe._emitEvent({ Kind: 'BATCH', From: 'evrd', Target: '', Args: ['+1', 'soju.im/bouncer-networks'], Message: 'soju.im/bouncer-networks', Raw: '' });
        probe._emitEvent({ Kind: 'BOUNCER', From: 'evrd', Target: '', Args: ['NETWORK', '3', 'name=Libera;host=irc.libera.chat;state=connected'], Message: '', Tags: { batch: '1' }, Raw: '' });
        probe._emitEvent({ Kind: 'BOUNCER', From: 'evrd', Target: '', Args: ['NETWORK', '9', 'name=IRC\\sForever;state=disconnected'], Message: '', Tags: { batch: '1' }, Raw: '' });
        // *status chatter (evrd's own sign-in notices) is not a network list.
        probe._emitEvent({ Kind: 'PRIVMSG', From: '*status', Target: 'me', Message: '| not | a table |', Raw: '' });
        probe._emitEvent({ Kind: 'BATCH', From: 'evrd', Target: '', Args: ['-1'], Message: '-1', Raw: '' });
        // The batch end resolves at once — no capture window.
        await expect(p).resolves.toEqual(['Libera', 'IRC Forever']);
        expect(probe.disconnectCalls).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
      bloc.dispose();
    });

    it('surfaces FAIL BOUNCER from a soju-style bouncer', async () => {
      const { bloc, engine } = await makeBloc();
      const p = bloc.discoverBouncerNetworks();
      const probe = engine.sessionFor('__bouncer-probe__');
      probe._emitEvent({ Kind: 'CAP', From: 'soju', Target: '', Args: ['ACK', 'soju.im/bouncer-networks'], Message: 'soju.im/bouncer-networks', Raw: '' });
      probe._emitEvent({ Kind: '001', From: 'soju', Target: 'me', Message: 'welcome', Raw: '' });
      probe._emitEvent({ Kind: 'FAIL', From: 'soju', Target: '', Args: ['BOUNCER', 'UNKNOWN_ERROR', 'LISTNETWORKS'], Message: 'Internal error', Raw: '' });
      await expect(p).rejects.toThrow(/Internal error/);
      bloc.dispose();
    });

    it('rejects discovery when the bouncer profile is disabled', async () => {
      const storage = memoryStorage();
      const sessionStore = new SessionStore(storage);
      setBouncerStore(await fastBouncerStore({ ...profile, enabled: false }));
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory: fakeDirectory({ user: fakeUser('alice'), servers: [] }),
        identity: fakeIdentity(), engine: fakeEngine().client, sessionStore,
      });
      await flushPromises(4);
      await expect(bloc.discoverBouncerNetworks()).rejects.toThrow(/User Settings/);
      bloc.dispose();
    });
  });

  // After the directory moved to /v1 (ids `net_…`), sessions saved before
  // still key their servers by the legacy uuid: the rail icon, sidebar banner
  // and Edit tab must still find the listing, without re-keying the session.
  describe('directory listings of saved servers', () => {
    const LEGACY = '398464ce-c861-4244-a16c-b26c046a1bd4';
    const boson: FakeNetwork = {
      id: 'net_01BOSON', hostname: 'irc.boson.chat', name: 'Boson',
      icon_url: 'https://directory.boson.chat/media/server-icons/b.png',
      banner_url: 'https://directory.boson.chat/media/server-banners/b.png',
    };

    async function settle(): Promise<void> {
      for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
    }

    function setupSaved(networks: FakeNetwork[]) {
      const sessionStore = new SessionStore(memoryStorage());
      sessionStore.upsertServer({ id: LEGACY, name: 'Boson', hostname: 'irc.boson.chat', port: 6697, tls: true });
      const main = fakeNetworkDirectory('https://directory.boson.chat', 'Boson', networks);
      const transport = fakeTransport([main]);
      const sources = new DirectorySources({ storage: memoryStorage(), transport, authUrl: 'https://auth.boson.chat' });
      const directory = fakeDirectory({ user: fakeUser('alice') });
      const engine = fakeEngine();
      const bloc = new DirectoryBloc({
        auth: fakeAuth(),
        directory,
        networks: new NetworkDirectories(sources, { getToken: async () => 'jwt' }, transport, (p) => directory.listServers(p)),
        identity: fakeIdentity(),
        engine: engine.client,
        sessionStore,
      });
      return { bloc, main, engine, sessionStore };
    }

    it('finds the listing of a server saved under its legacy id (by legacy_id)', async () => {
      const { bloc, engine, main } = setupSaved([{ ...boson, legacy_id: LEGACY }]);
      await settle();
      expect(engine.connectCalls.map((c) => c.serverId)).toEqual([LEGACY]);
      const row = bloc.getState().listings[LEGACY];
      expect(row?.id).toBe('net_01BOSON');
      expect(row?.icon_url).toBe(boson.icon_url);
      expect(row?.banner_url).toBe(boson.banner_url);
      // On the loaded page: no lookup needed.
      expect(main.requests.some((r) => r.url.includes('/v1/networks/lookup'))).toBe(false);
      bloc.dispose();
    });

    it('finds it by address when the directory gives no legacy id', async () => {
      const { bloc } = setupSaved([boson]);
      await settle();
      expect(bloc.getState().listings[LEGACY]?.icon_url).toBe(boson.icon_url);
      bloc.dispose();
    });

    it('looks the listing up when it is not on the loaded page', async () => {
      const filler: FakeNetwork[] = Array.from({ length: 30 }, (_, i) => ({ id: `net_f${i}`, hostname: `irc${i}.example`, name: `f${i}` }));
      const { bloc, main } = setupSaved([...filler, boson]);
      await settle();
      expect(bloc.getState().servers?.some((s) => s.hostname === 'irc.boson.chat')).toBe(false);
      expect(bloc.getState().listings[LEGACY]?.banner_url).toBe(boson.banner_url);
      const lookups = main.requests.filter((r) => r.url.includes('/v1/networks/lookup'));
      expect(lookups.map((r) => r.url)).toEqual(['https://directory.boson.chat/v1/networks/lookup?hostname=irc.boson.chat']);
      // Remembered: later emits don't look it up again.
      bloc.setQuery('nothing-matches');
      await settle();
      expect(main.requests.filter((r) => r.url.includes('/v1/networks/lookup'))).toHaveLength(1);
      expect(bloc.getState().listings[LEGACY]?.icon_url).toBe(boson.icon_url);
      bloc.dispose();
    });

    it('joining the listing reuses the open connection saved under the legacy id', async () => {
      const { bloc, engine, sessionStore } = setupSaved([boson]);
      await settle();
      const row = bloc.getState().servers!.find((s) => s.id === 'net_01BOSON')!;
      await bloc.connect(row);
      await settle();
      expect(engine.connectCalls.map((c) => c.serverId)).toEqual([LEGACY]);
      expect(bloc.getState().connections.map((c) => c.serverId)).toEqual([LEGACY]);
      expect(sessionStore.load()?.servers.map((s) => s.server.id)).toEqual([LEGACY]);
      bloc.dispose();
    });
  });

  describe('network accounts (self-hosted sign-in)', () => {
    // A stand-in for NetworkAccounts: irc.net.org's network has its own
    // auth service; the user may or may not be signed in to it.
    function fakeAccounts(o: { signedIn?: boolean; guestOk?: boolean } = {}) {
      let signedIn = o.signedIn ?? false;
      const link = { host: 'irc.net.org', authUrl: 'https://auth.net.org', main: false };
      const prompts: Array<{ reason: string; allowGuest: boolean; resolve: (r: string) => void }> = [];
      const guest = new Set<string>();
      const accounts = {
        discover: vi.fn(async (h: string) => (h === 'irc.net.org' ? link : null)),
        sessionFor: () => (signedIn ? { user: { username: 'alice' } } : null),
        ircToken: vi.fn(async () => (signedIn ? 'net-token' : null)),
        guestAllowed: vi.fn(async () => o.guestOk ?? true),
        guestChosen: (h: string) => guest.has(h),
        setGuestChosen: (h: string, on: boolean) => { if (on) guest.add(h); else guest.delete(h); },
        nameFor: () => 'Net',
        promptSignIn: vi.fn((p: { reason: string; allowGuest: boolean }) => new Promise((resolve) => prompts.push({ ...p, resolve }))),
      };
      return { accounts, prompts, signIn: () => { signedIn = true; } };
    }

    async function netBloc(accounts: unknown) {
      const engine = fakeEngine();
      const server = fakeServer('net', { hostname: 'irc.net.org' });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(),
        directory: fakeDirectory({ user: fakeUser('alice-handle'), servers: [server] }),
        identity: fakeIdentity(),
        engine: engine.client,
        sessionStore: new SessionStore(memoryStorage()),
        netAccounts: accounts as never,
      });
      await flushPromises(4);
      return { bloc, engine, server };
    }

    it('logs in to IRC with the network token (OAUTHBEARER) as the network username', async () => {
      const { accounts } = fakeAccounts({ signedIn: true });
      const { bloc, engine, server } = await netBloc(accounts);
      await bloc.connect(server);
      expect(engine.connectCalls[0]).toMatchObject({ oauthbearer: { token: 'net-token' }, nick: 'alice' });
      expect(accounts.promptSignIn).not.toHaveBeenCalled();
      bloc.dispose();
    });

    it('asks first when signed out; a guest connects without a token', async () => {
      const { accounts, prompts } = fakeAccounts();
      const { bloc, engine, server } = await netBloc(accounts);
      const p = bloc.connect(server);
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      expect(prompts[0]).toMatchObject({ reason: 'connect', allowGuest: true });
      expect(engine.connectCalls).toHaveLength(0);
      prompts[0]!.resolve('guest');
      await p;
      expect(engine.connectCalls[0]?.oauthbearer).toBeUndefined();
      expect(engine.connectCalls[0]?.nick).toBe('alice-handle');
      bloc.dispose();
    });

    it("doesn't connect when the sign-in is cancelled", async () => {
      const { accounts, prompts } = fakeAccounts({ guestOk: false });
      const { bloc, engine, server } = await netBloc(accounts);
      const p = bloc.connect(server);
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      expect(prompts[0]).toMatchObject({ reason: 'required', allowGuest: false });
      prompts[0]!.resolve('cancel');
      await p;
      expect(engine.connectCalls).toHaveLength(0);
      bloc.dispose();
    });

    it('turns "no guests" from the IRC server into a sign-in, then reconnects with the account', async () => {
      const { accounts, prompts, signIn } = fakeAccounts();
      accounts.setGuestChosen('irc.net.org', true);
      const { bloc, engine, server } = await netBloc(accounts);
      await bloc.connect(server);
      const s = engine.sessionFor('net');
      s._emitEvent({ Kind: 'FAIL', Args: ['*', 'ACCOUNT_REQUIRED'], Message: 'You must log in with SASL to join this server' } as IrcEvent);
      s._setState('disconnected', 'ERROR: You must log in with SASL to join this server');
      expect(activeConnection(bloc.getState())?.error).toMatch(/Net requires an account/);
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      expect(prompts[0]).toMatchObject({ reason: 'required', allowGuest: false });
      expect(accounts.guestChosen('irc.net.org')).toBe(false);
      signIn();
      prompts[0]!.resolve('signed-in');
      await vi.waitFor(() => expect(engine.connectCalls).toHaveLength(2));
      expect(engine.connectCalls[1]).toMatchObject({ oauthbearer: { token: 'net-token' } });
      bloc.dispose();
    });

    it('a "Password required" (464) from a network with accounts asks to sign in instead of retrying', async () => {
      // A self-hosted network's bouncer bridge takes only its own accounts'
      // tokens: a guest connect gets 464, not FAIL ACCOUNT_REQUIRED.
      const { accounts, prompts, signIn } = fakeAccounts();
      accounts.setGuestChosen('irc.net.org', true);
      const { bloc, engine, server } = await netBloc(accounts);
      await bloc.connect(server);
      const s = engine.sessionFor('net');
      s._emitEvent({ Kind: '464', Message: 'Password required' } as IrcEvent);
      s._setState('disconnected', 'Password required');
      expect(activeConnection(bloc.getState())?.error).toMatch(/Net requires an account/);
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      expect(prompts[0]).toMatchObject({ reason: 'required' });
      signIn();
      prompts[0]!.resolve('signed-in');
      await vi.waitFor(() => expect(engine.connectCalls).toHaveLength(2));
      expect(engine.connectCalls[1]).toMatchObject({ oauthbearer: { token: 'net-token' } });
      bloc.dispose();
    });

    it('a refused token offers signing in again or a guest connect', async () => {
      const { accounts, prompts } = fakeAccounts({ signedIn: true });
      const { bloc, engine, server } = await netBloc(accounts);
      await bloc.connect(server);
      const s = engine.sessionFor('net');
      s._emitEvent({ Kind: '904', Message: 'SASL authentication failed' } as IrcEvent);
      s._setState('disconnected', 'closing connection: SASL authentication failed');
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      expect(prompts[0]).toMatchObject({ reason: 'expired', allowGuest: true });
      prompts[0]!.resolve('guest');
      await vi.waitFor(() => expect(engine.connectCalls).toHaveLength(2));
      expect(engine.connectCalls[1]?.oauthbearer).toBeUndefined();
      bloc.dispose();
    });

    it('bouncer routes never send the network token', async () => {
      const { accounts } = fakeAccounts({ signedIn: true });
      setBouncerStore(await fastBouncerStore({ enabled: true, host: 'znc.example', port: 6697, tls: true, username: 'u', password: 'p' } as BouncerProfile));
      const storage = memoryStorage();
      const sessionStore = new SessionStore(storage);
      const engine = fakeEngine();
      const server = fakeServer('net', { hostname: 'irc.net.org' });
      sessionStore.upsertServer({ id: 'net', name: 'net', hostname: 'irc.net.org', port: 6697, tls: true });
      sessionStore.setServerBouncer?.('net', { route: true, network: 'net' });
      const bloc = new DirectoryBloc({
        auth: fakeAuth(), directory: fakeDirectory({ user: fakeUser(), servers: [server] }), identity: fakeIdentity(),
        engine: engine.client, sessionStore, netAccounts: accounts as never,
      });
      await flushPromises(4);
      bloc.setServerBouncer('net', { route: true, network: 'net' });
      await bloc.connect(server);
      const c = engine.connectCalls.at(-1)!;
      expect(c.serverPass).toBeTruthy();
      expect(c.oauthbearer).toBeUndefined();
      bloc.dispose();
    });
  });
});

// A listing's default channels (autojoin_channels): joined by the client on
// the first connect from its card, ~3s after registration, unless the
// network's own auto-join already put us there; never again after that.
describe('DirectoryBloc — a listing\'s default channels', () => {
  const DONE_KEY = 'boson:autojoin-done:v1';
  beforeEach(async () => {
    vi.useRealTimers();
    localStorage.removeItem(DONE_KEY);
    setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
    setBouncerStore(await fastBouncerStore());
  });
  afterEach(() => { vi.useRealTimers(); localStorage.removeItem(DONE_KEY); });

  async function connected(server: Server) {
    const engine = fakeEngine();
    const bloc = new DirectoryBloc({
      auth: fakeAuth(),
      directory: fakeDirectory({ user: fakeUser('alice'), servers: [server] }),
      identity: fakeIdentity(),
      engine: engine.client,
      sessionStore: new SessionStore(memoryStorage()),
    });
    await flushPromises(4);
    await bloc.connect(server);
    vi.useFakeTimers();
    const session = engine.sessionFor(server.id);
    session._setState('connected');
    return { bloc, engine, session };
  }

  const selfJoin = (session: { _emitEvent(e: IrcEvent): void }, channel: string): void =>
    session._emitEvent({ Kind: 'JOIN', From: 'alice', Target: channel, Message: '', Raw: '' } as IrcEvent);

  it('joins them a few seconds after registration, once per network', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const server = fakeServer('lobbynet', { autojoin_channels: ['#lobby', '#help'] });
    const { bloc, session } = await connected(server);
    vi.advanceTimersByTime(2000);
    expect(session.joinCalls).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(session.joinCalls).toEqual(['#lobby', '#help']);
    expect(JSON.parse(localStorage.getItem(DONE_KEY)!)).toEqual(['irc.lobbynet:6697']);
    bloc.disconnect('lobbynet');
    vi.useRealTimers();

    // Connecting again: nothing more.
    const again = await connected(server);
    vi.advanceTimersByTime(5000);
    expect(again.session.joinCalls).toEqual([]);
    again.bloc.dispose();
    bloc.dispose();
    info.mockRestore();
  });

  it('skips the ones the server already joined us to', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const server = fakeServer('sajoined', { autojoin_channels: ['#Lobby', '#help'] });
    const { bloc, session } = await connected(server);
    selfJoin(session, '#lobby'); // RoleServ's SAJOIN landed first
    vi.advanceTimersByTime(3000);
    expect(session.joinCalls).toEqual(['#help']);
    bloc.dispose();
    info.mockRestore();
  });

  it('a refused default channel shows no error', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const server = fakeServer('refuses', { autojoin_channels: ['#lobby'] });
    const { bloc, session } = await connected(server);
    vi.advanceTimersByTime(3000);
    expect(session.joinCalls).toEqual(['#lobby']);
    const conn = bloc.getState().connections[0]!;
    const feedback: unknown[] = [];
    conn.chat.onFeedback((f) => feedback.push(f));
    session._emitEvent({ Kind: '474', Target: 'alice', Message: 'banned', Args: ['#lobby', 'banned'], From: '', Raw: '' } as IrcEvent);
    expect(feedback).toEqual([]);
    expect(conn.chat.getState().channels.map((c) => c.name)).not.toContain('#lobby');
    bloc.dispose();
    info.mockRestore();
  });

  it('listings without default channels, and restores, join nothing extra', async () => {
    const { bloc, session } = await connected(fakeServer('plain'));
    vi.advanceTimersByTime(5000);
    expect(session.joinCalls).toEqual([]);
    expect(localStorage.getItem(DONE_KEY)).toBeNull();
    bloc.dispose();
  });

  it('dropped before the delay: tried on the next registration instead', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const server = fakeServer('flaky', { autojoin_channels: ['#lobby'] });
    const { bloc, session } = await connected(server);
    session._setState('disconnected');
    vi.advanceTimersByTime(3000);
    expect(session.joinCalls).toEqual([]);
    expect(localStorage.getItem(DONE_KEY)).toBeNull();
    session._setState('connected');
    vi.advanceTimersByTime(3000);
    expect(session.joinCalls).toEqual(['#lobby']);
    bloc.dispose();
    info.mockRestore();
  });
});

// Reopening the app (on a phone: backgrounded, then killed by the OS — no
// unload) comes back to the server and channel the user last had open.
describe('DirectoryBloc — a relaunch returns to the last server + channel', () => {
  const row = (id: string, channels: string[], activeChannel: string | null) => ({
    server: { id, name: id, hostname: `irc.${id}`, port: 6697, tls: true }, channels, activeChannel,
  });
  const profile: BouncerProfile = {
    enabled: true, host: 'znc.host', port: 7000, tls: true,
    tlsInsecure: true, username: 'me', password: 'pw',
  };
  const join = (nick: string, ch: string): IrcEvent => ({ Kind: 'JOIN', From: nick, Target: ch, Message: '', Raw: '' });
  const savedActive = (store: SessionStore, id: string) =>
    store.load()!.servers.find((s) => s.server.id === id)!.activeChannel;
  const chatOf = (bloc: DirectoryBloc, id: string) =>
    bloc.getState().connections.find((c) => c.serverId === id)!.chat;

  beforeEach(async () => {
    vi.useRealTimers();
    setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
    setBouncerStore(await fastBouncerStore());
  });
  afterEach(() => { vi.useRealTimers(); });

  function launch(storage: Storage, engine: FakeEngine, remote: unknown = null) {
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [] });
    (directory.getSavedSession as ReturnType<typeof vi.fn>).mockResolvedValue(remote);
    const sessionStore = new SessionStore(storage);
    const bloc = new DirectoryBloc({
      auth: fakeAuth(), directory, identity: fakeIdentity(), engine: engine.client, sessionStore,
    });
    return { bloc, directory, sessionStore };
  }

  // The account's synced copy holds whichever device pushed last (the
  // desktop, say), or this phone's own state from before its last switch
  // (the debounced push never left before the app was killed).
  it('the synced session from the account doesn\'t move this device off its server + channel', async () => {
    const storage = memoryStorage();
    new SessionStore(storage).save({
      servers: [row('a', ['#general'], '#general'), row('b', ['#other', '#x'], '#x')],
      activeServerId: 'b',
    });
    const remote = {
      servers: [row('a', ['#general'], '#general'), row('b', ['#other', '#x'], '#other')],
      activeServerId: 'a',
    };
    const engine = fakeEngine();
    const { bloc, sessionStore } = launch(storage, engine, remote);
    await flushPromises(6);
    expect(engine.connectCalls.map((c) => c.serverId).sort()).toEqual(['a', 'b']);
    expect(bloc.getState().activeServerId).toBe('b');

    const b = engine.sessionFor('b');
    b._setState('connected');
    await flushPromises(4);
    expect(b.joinCalls).toEqual(['#other', '#x']);
    // Shown straight away (its history), not the last channel to be joined.
    expect(chatOf(bloc, 'b').getState().activeChannel).toBe('#x');
    b._emitEvent(join(engine.connectCalls.find((c) => c.serverId === 'b')!.nick, '#other'));
    b._emitEvent(join(engine.connectCalls.find((c) => c.serverId === 'b')!.nick, '#x'));
    expect(chatOf(bloc, 'b').getState().activeChannel).toBe('#x');
    expect(savedActive(sessionStore, 'b')).toBe('#x');
    expect(sessionStore.load()!.activeServerId).toBe('b');
    bloc.dispose();
  });

  it('a server or channel this device was on that\'s gone from the synced set falls back to the synced cursor', async () => {
    const storage = memoryStorage();
    new SessionStore(storage).save({
      servers: [row('a', ['#general'], '#general'), row('gone', ['#x'], '#x')],
      activeServerId: 'gone',
    });
    const remote = { servers: [row('a', ['#general', '#new'], '#new')], activeServerId: 'a' };
    const engine = fakeEngine();
    const { bloc, sessionStore } = launch(storage, engine, remote);
    await flushPromises(6);
    expect(bloc.getState().activeServerId).toBe('a');
    // #general is still in the set: this device's pick stands.
    expect(savedActive(sessionStore, 'a')).toBe('#general');
    bloc.dispose();
  });

  // Through a bouncer nothing is joined by us: the channels come back as the
  // bouncer replays them, and the one the user was in may come well after
  // the first (ZNC rejoining at its flood rate, its network still coming
  // up). The stand-in shown meanwhile isn't saved over the real choice, so
  // a kill in that window doesn't lose it either.
  it('through a bouncer: a channel that comes back late still wins, and a kill meanwhile doesn\'t lose it', async () => {
    const storage = memoryStorage();
    const seed = new SessionStore(storage);
    seed.save({ servers: [row('a', ['#general'], '#general'), row('b', ['#other', '#x'], '#x')], activeServerId: 'b' });
    seed.setServerBouncer('b', { route: true, network: 'b' });
    seed.setBouncerSeeded('b');
    setBouncerStore(await fastBouncerStore(profile));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    // First run: the bouncer replays #other; #x hasn't come back yet.
    let engine = fakeEngine();
    let run = launch(storage, engine);
    await flushPromises(8);
    let b = engine.sessionFor('b');
    let nick = engine.connectCalls.find((c) => c.serverId === 'b')!.nick;
    b._setState('connected');
    await flushPromises(4);
    b._emitBouncerUpstream('connected');
    b._emitEvent(join(nick, '#other'));
    vi.advanceTimersByTime(5_000);
    expect(chatOf(run.bloc, 'b').getState().activeChannel).toBe('#other'); // a stand-in
    expect(savedActive(run.sessionStore, 'b')).toBe('#x');
    // Backgrounded, then killed: no unload, nothing more runs.
    run.bloc.dispose();

    // Relaunch.
    engine = fakeEngine();
    run = launch(storage, engine);
    await flushPromises(8);
    expect(run.bloc.getState().activeServerId).toBe('b');
    b = engine.sessionFor('b');
    nick = engine.connectCalls.find((c) => c.serverId === 'b')!.nick;
    b._setState('connected');
    await flushPromises(4);
    b._emitBouncerUpstream('connected');
    b._emitEvent(join(nick, '#other'));
    vi.advanceTimersByTime(10_000);
    expect(chatOf(run.bloc, 'b').getState().activeChannel).toBe('#other');
    b._emitEvent(join(nick, '#x'));
    expect(chatOf(run.bloc, 'b').getState().activeChannel).toBe('#x');
    expect(savedActive(run.sessionStore, 'b')).toBe('#x');
    expect(b.joinCalls).toEqual([]); // the bouncer's channels aren't re-sent
    run.bloc.dispose();
  });

  it('a notification tap during the restore wins over it', async () => {
    const storage = memoryStorage();
    new SessionStore(storage).save({ servers: [row('b', ['#other', '#x', '#y'], '#x')], activeServerId: 'b' });
    const engine = fakeEngine();
    const { bloc, sessionStore } = launch(storage, engine);
    await flushPromises(6);
    // The app was started by the tap: it's applied once the server connects.
    (bloc as unknown as { activateFromNotification(s: string, c: string): void }).activateFromNotification('b', '#y');
    const b = engine.sessionFor('b');
    const nick = engine.connectCalls[0]!.nick;
    b._setState('connected');
    await flushPromises(6);
    b._emitEvent(join(nick, '#other'));
    b._emitEvent(join(nick, '#x'));
    b._emitEvent(join(nick, '#y'));
    await new Promise((r) => setTimeout(r, 0)); // the chat's emit
    expect(chatOf(bloc, 'b').getState().activeChannel).toBe('#y');
    expect(savedActive(sessionStore, 'b')).toBe('#y');
    bloc.dispose();
  });

  it('a channel the user asks to join on a saved server is shown, not the restored one', async () => {
    const storage = memoryStorage();
    new SessionStore(storage).save({ servers: [row('b', ['#x'], '#x')], activeServerId: 'b' });
    new SessionStore(storage).upsertServer({ id: 'b', name: 'b', hostname: 'irc.b', port: 6697, tls: true });
    const engine = fakeEngine();
    const directory = fakeDirectory({ user: fakeUser('alice'), servers: [fakeServer('b')] });
    const sessionStore = new SessionStore(storage);
    // A guest restore isn't wanted here: start without the saved set, then
    // connect from the directory with a channel to join.
    const bloc = new DirectoryBloc({
      auth: fakeAuth(), directory, identity: fakeIdentity({ unlocked: false }), engine: engine.client, sessionStore,
    });
    await flushPromises(6);
    expect(engine.connectCalls).toHaveLength(0);
    await bloc.connect(fakeServer('b'), { join: '#new' });
    await flushPromises(4);
    const b = engine.sessionFor('b');
    const nick = engine.connectCalls[0]!.nick;
    b._setState('connected');
    await flushPromises(4);
    expect(b.joinCalls).toEqual(['#new']);
    b._emitEvent(join(nick, '#x'));
    b._emitEvent(join(nick, '#new'));
    expect(chatOf(bloc, 'b').getState().activeChannel).toBe('#new');
    bloc.dispose();
  });

  it('going to the background sends a pending session push at once', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    new SessionStore(storage).save({ servers: [row('a', ['#general', '#x'], '#general')], activeServerId: 'a' });
    const engine = fakeEngine();
    const { bloc, directory } = launch(storage, engine);
    await vi.advanceTimersByTimeAsync(0);
    const a = engine.sessionFor('a');
    a._setState('connected');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    (directory.putSavedSession as ReturnType<typeof vi.fn>).mockClear();
    chatOf(bloc, 'a').setActive('#x');
    await vi.advanceTimersByTimeAsync(0); // the chat's emit: saved, push debounced
    expect(directory.putSavedSession).not.toHaveBeenCalled();
    const vis = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      if (vis) Object.defineProperty(document, 'visibilityState', vis);
      else delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    expect(directory.putSavedSession).toHaveBeenCalledTimes(1);
    const sent = (directory.putSavedSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { servers: Array<{ activeChannel: string }> };
    expect(sent.servers[0]!.activeChannel).toBe('#x');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(directory.putSavedSession).toHaveBeenCalledTimes(1); // not again
    bloc.dispose();
  });
});
