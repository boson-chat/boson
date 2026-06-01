import { vi } from 'vitest';
import { render } from '@testing-library/preact';
import type { ComponentChild } from 'preact';
import type { Session } from '@supabase/supabase-js';

import { AuthProvider, type AuthListener, type AuthService, type AuthState } from '../modules/auth';
import { DirectoryService } from '../modules/directory';
import { ChatService } from '../modules/chat';
import {
  EngineClient,
  type WebSocketCtor,
  type WebSocketLike,
} from '../modules/engine';
import { IdentityService } from '../modules/identity';
import { HttpClient } from '../shared/http/http.client';
import { LoginScreen } from '../screens/LoginScreen';
import { DirectoryScreen } from '../screens/DirectoryScreen';
import { ChatLayout } from '../screens/ChatLayout';
import { SessionStore } from '../modules/session';

// ---------------------------------------------------------------------------
// fetch boundary mock
// ---------------------------------------------------------------------------

export type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

// Install a global `fetch` stub that dispatches by "METHOD /path".
// Path matching is exact on `pathname` (querystring is exposed via the init.url
// passthrough below — handlers can inspect it on their own if they want).
// Returns the restore function so individual tests can clean up early.
export function mockFetch(routes: Record<string, RouteHandler>): () => void {
  const previous = globalThis.fetch;
  const handler: typeof fetch = async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
    const method = (init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).method : undefined) ?? 'GET').toUpperCase();
    const parsed = new URL(url, 'http://test.local');
    const key = `${method} ${parsed.pathname}`;
    const fn = routes[key];
    if (!fn) {
      return new Response(JSON.stringify({ error: `no mock route for ${key}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return fn(init);
  };
  globalThis.fetch = handler as unknown as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Fake AuthService — satisfies the structural shape used by LoginBloc /
// DirectoryBloc / useAuthState without depending on a real Supabase client.
// Tests can flip its state with helpers (`_setSession`, `_finishLoading`).
// ---------------------------------------------------------------------------

export interface FakeAuthOptions {
  email?: string;
  session?: Session | null;
  // signIn rejects with this if set (test the wrong-password branch).
  signInError?: Error | null;
  // signUp rejects with this if set.
  signUpError?: Error | null;
  // When true, signUp() also establishes a session (matches the
  // Supabase confirm-disabled flow on local dev). Default false
  // matches the canonical confirm-enabled flow where signUp returns
  // user-but-no-session and the user lands on "Check your email".
  signUpEstablishesSession?: boolean;
}

export class FakeAuthService {
  private state: AuthState;
  private readonly listeners = new Set<AuthListener>();
  private signInError: Error | null;
  private signUpError: Error | null;
  private email: string;
  signUpEstablishesSession: boolean;

  // Each call records its (email,password) tuple so tests can assert.
  signInCalls: Array<{ email: string; password: string }> = [];
  signUpCalls: Array<{ email: string; password: string }> = [];
  signOutCalls = 0;

  constructor(opts: FakeAuthOptions = {}) {
    this.state = { session: opts.session ?? null, loading: false, error: null };
    this.signInError = opts.signInError ?? null;
    this.signUpError = opts.signUpError ?? null;
    this.email = opts.email ?? 'test@boson.dev';
    this.signUpEstablishesSession = opts.signUpEstablishesSession ?? false;
  }

  async init(): Promise<void> {
    // Already non-loading by default in tests.
    this.setState({ ...this.state, loading: false });
  }

  async signIn(email: string, password: string): Promise<void> {
    this.signInCalls.push({ email, password });
    if (this.signInError) throw this.signInError;
    this._setSession({
      access_token: 'jwt-test',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'refresh',
      user: { id: 'u1', email } as unknown as Session['user'],
    } as unknown as Session);
  }

  async signUp(email: string, password: string): Promise<void> {
    this.signUpCalls.push({ email, password });
    if (this.signUpError) throw this.signUpError;
    // Real Supabase only returns a session immediately when email
    // confirmation is DISABLED on the project. The default flow
    // (confirm-on, hosted dev → click email link) returns no session
    // here — the user lands on "Check your email" until the deep
    // link fires. Tests that want auto-session can opt-in via
    // signUpEstablishesSession=true; default matches the
    // confirm-enabled flow that LoginBloc's awaitingConfirmation
    // branch was designed for.
    if (this.signUpEstablishesSession) {
      this._setSession({
        access_token: 'jwt-test',
        token_type: 'bearer',
        expires_in: 3600,
        refresh_token: 'refresh',
        user: { id: 'u1', email } as unknown as Session['user'],
      } as unknown as Session);
    }
  }

  async signOut(): Promise<void> {
    this.signOutCalls++;
    this._setSession(null);
  }

  async getToken(): Promise<string | null> {
    return this.state.session?.access_token ?? null;
  }

  getState(): AuthState { return this.state; }

  subscribe(fn: AuthListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => { this.listeners.delete(fn); };
  }

  markFatal(message: string): void {
    this.setState({ ...this.state, loading: false, error: message });
  }

  // Test-only hooks (prefixed with _ to mark internal):
  _setSession(session: Session | null): void {
    this.setState({ ...this.state, session, loading: false, error: null });
  }

  _email(): string { return this.email; }

  private setState(next: AuthState): void {
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
  }
}

// Cast helper — TypeScript's structural typing doesn't quite match (private
// fields on the real AuthService class), but the consumers only use the
// public surface. This explicit cast keeps the test sites readable.
export function asAuthService(fake: FakeAuthService): AuthService {
  return fake as unknown as AuthService;
}

// ---------------------------------------------------------------------------
// FakeWebSocket — implements WebSocketLike + exposes test handles to drive
// open / message / close from the test. Pair with `engine.client.ts`'s
// injectable wsCtor.
// ---------------------------------------------------------------------------

export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((this: WebSocketLike, ev: Event) => void) | null = null;
  onclose: ((this: WebSocketLike, ev: CloseEvent) => void) | null = null;
  onerror: ((this: WebSocketLike, ev: Event) => void) | null = null;
  onmessage: ((this: WebSocketLike, ev: MessageEvent) => void) | null = null;

  // Every JSON command the EngineClient sends lands here so tests can assert
  // command-issuance behaviour without poking at the WS.
  readonly sent: string[] = [];

  // Tracks every FakeWebSocket constructed during a test — used by helpers
  // that don't have a direct reference to the instance (e.g. `mountChat()`).
  static instances: FakeWebSocket[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  static reset(): void { FakeWebSocket.instances = []; }
  static latest(): FakeWebSocket | null {
    return FakeWebSocket.instances.at(-1) ?? null;
  }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('InvalidStateError: WebSocket not OPEN');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  // ---- Test-only drivers ----
  _open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  _receive(payload: unknown): void {
    // Auto-tag the default test serverId onto outgoing simulated messages
    // so the EngineClient's serverId-based routing matches what mountChat()
    // sets up. Tests that need a different id can pass `serverId` explicitly
    // on the payload object — the spread below preserves that override.
    const pl = payload && typeof payload === 'object'
      ? { serverId: 'srv-test', ...(payload as Record<string, unknown>) }
      : payload;
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(pl) }));
  }
  _close(): void { this.close(); }
  _error(): void { this.onerror?.(new Event('error')); }
}

export const FakeWSCtor: WebSocketCtor = FakeWebSocket as unknown as WebSocketCtor;

// ---------------------------------------------------------------------------
// Identity helper. Real IdentityService is fine, but we pass a no-op KDF so
// tests don't spend ~200ms on each Argon2id call.
// ---------------------------------------------------------------------------

export function makeIdentity(): IdentityService {
  // The 32-byte output the bloc expects. Pure-function identity — same key
  // for same (password,salt) so unlock() round-trips after initializeForNewUser.
  return new IdentityService((password, salt) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      out[i] = (password.charCodeAt(i % Math.max(password.length, 1)) + salt[i]!) & 0xff;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// In-memory localStorage so SessionStore doesn't pollute happy-dom's shared
// global between tests.
// ---------------------------------------------------------------------------

export function memorySessionStore(): SessionStore {
  const map = new Map<string, string>();
  return new SessionStore({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  });
}

// ---------------------------------------------------------------------------
// Mount helpers — assemble real bloc + real view exactly like buildApp() does.
// ---------------------------------------------------------------------------

export interface MountedLogin {
  auth: FakeAuthService;
  directory: DirectoryService;
  identity: IdentityService;
  rendered: ReturnType<typeof render>;
  unmount: () => void;
}

export function mountLogin(opts: {
  auth?: FakeAuthService;
  bosonUrl?: string;
  identity?: IdentityService;
} = {}): MountedLogin {
  const auth = opts.auth ?? new FakeAuthService();
  const identity = opts.identity ?? makeIdentity();
  const http = new HttpClient(opts.bosonUrl ?? 'http://api.test', {
    getToken: () => auth.getToken(),
  });
  const directory = new DirectoryService(http);
  const rendered = render(
    <AuthProvider service={asAuthService(auth)}>
      <LoginScreen directory={directory} identity={identity} />
    </AuthProvider>
  );
  return { auth, directory, identity, rendered, unmount: () => rendered.unmount() };
}

export interface MountedDirectory {
  auth: FakeAuthService;
  directory: DirectoryService;
  identity: IdentityService;
  engine: EngineClient | null;
  rendered: ReturnType<typeof render>;
  unmount: () => void;
}

export function mountDirectory(opts: {
  auth?: FakeAuthService;
  bosonUrl?: string;
  identity?: IdentityService;
  engine?: EngineClient | null;
} = {}): MountedDirectory {
  const auth = opts.auth ?? new FakeAuthService({
    session: {
      access_token: 'jwt',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'r',
      user: { id: 'u1', email: 'a@b' } as unknown as Session['user'],
    } as unknown as Session,
  });
  const identity = opts.identity ?? makeIdentity();
  const http = new HttpClient(opts.bosonUrl ?? 'http://api.test', {
    getToken: () => auth.getToken(),
  });
  const directory = new DirectoryService(http);
  const engine = opts.engine ?? null;
  const rendered = render(
    <AuthProvider service={asAuthService(auth)}>
      <DirectoryScreen directory={directory} engine={engine} identity={identity} />
    </AuthProvider>
  );
  return { auth, directory, identity, engine, rendered, unmount: () => rendered.unmount() };
}

export interface MountedChat {
  chat: ChatService;
  engine: EngineClient;
  ws: FakeWebSocket;
  rendered: ReturnType<typeof render>;
  unmount: () => void;
}

// Builds a real EngineClient backed by FakeWebSocket, a real ServerSession +
// ChatService attached to it, and renders the real ChatLayout. Opens the WS
// so the engine is ready to send commands. The serverId used internally is
// 'srv-test' — incoming engine messages crafted by tests should carry the
// same id, but ws._receive() helpers don't care.
export async function mountChat(opts: {
  myNick?: string;
  serverName?: string;
} = {}): Promise<MountedChat> {
  FakeWebSocket.reset();
  const engine = new EngineClient(
    { url: 'ws://engine.test/ws', token: 't' },
    { wsCtor: FakeWSCtor, reconnect: false },
  );
  // Kick off open + drive the FakeWebSocket through its handshake. The await
  // resolves once the engine's open() promise settles.
  const opened = engine.open();
  FakeWebSocket.latest()!._open();
  await opened;
  const session = engine.connect({
    serverId: 'srv-test',
    hostname: 'irc.test',
    port: 6697,
    tls: true,
    nick: opts.myNick ?? 'me',
  });
  const chat = new ChatService(session, opts.myNick ?? 'me');
  chat.attach();
  const rendered = render(
    <ChatLayout
      chat={chat}
      serverName={opts.serverName ?? 'TestNet'}
      myNick={opts.myNick ?? 'me'}
      onBrowseServers={() => {}}
    />
  );
  return {
    chat,
    engine,
    ws: FakeWebSocket.latest()!,
    rendered,
    unmount: () => {
      rendered.unmount();
      chat.detach();
      engine.close();
    },
  };
}

// ---------------------------------------------------------------------------
// vi.mock-friendly nothing here, just re-exports so tests can pull from one
// place.
// ---------------------------------------------------------------------------

export { render } from '@testing-library/preact';
export { vi };
// Sentinel re-export to anchor the JSX runtime in scope for `.tsx` consumers.
export type IntegrationRoot = ComponentChild;
