import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EngineClient } from './engine.client';
import type { WebSocketLike, WebSocketCtor } from './engine.client';
import type { IrcEvent, EngineState } from './engine.types';

// Hand-rolled fake WebSocket so we can drive open/message/close at will.
class FakeWS implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWS.last = this;
  }
  static last: FakeWS | null = null;

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('InvalidStateError: WebSocket not OPEN');
    }
    this.sent.push(data);
  }
  close(): void { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }

  // test helpers
  simulateOpen(): void { this.readyState = 1; this.onopen?.(new Event('open')); }
  simulateMessage(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
  simulateError(): void { this.onerror?.(new Event('error')); }
}

const Ctor: WebSocketCtor = FakeWS as unknown as WebSocketCtor;

describe('EngineClient', () => {
  beforeEach(() => { FakeWS.last = null; });

  it('open() appends ?token= to the URL', async () => {
    const client = new EngineClient({ url: 'ws://localhost:7331/ws', token: 'tok 1' }, Ctor);
    const p = client.open();
    expect(FakeWS.last?.url).toBe('ws://localhost:7331/ws?token=tok%201');
    FakeWS.last!.simulateOpen();
    await p;
  });

  it('open() rejects when the socket errors', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateError();
    await expect(p).rejects.toThrow();
  });

  it('connect() returns a ServerSession; the JSON connect command carries the serverId', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const states: EngineState[] = [];
    const session = client.connect({ serverId: 'srv-a', hostname: 'irc', port: 6697, tls: true, nick: 'alice' });
    session.onState((s) => states.push(s));
    expect(session.serverId).toBe('srv-a');
    expect(session.state()).toBe('connecting');
    expect(states).toContain('connecting');

    expect(FakeWS.last!.sent).toHaveLength(1);
    expect(JSON.parse(FakeWS.last!.sent[0]!)).toEqual({
      type: 'connect',
      params: { serverId: 'srv-a', hostname: 'irc', port: 6697, tls: true, nick: 'alice' },
    });
  });

  it('forwards incoming events to the matching ServerSession only', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const a = client.connect({ serverId: 'srv-a', hostname: 'irc-a', port: 6697, tls: true, nick: 'me' });
    const b = client.connect({ serverId: 'srv-b', hostname: 'irc-b', port: 6697, tls: true, nick: 'me' });
    const aEvents: IrcEvent[] = [];
    const bEvents: IrcEvent[] = [];
    a.onEvent((e) => aEvents.push(e));
    b.onEvent((e) => bEvents.push(e));

    FakeWS.last!.simulateMessage({
      type: 'event',
      serverId: 'srv-a',
      event: { Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: 'hi-a', Raw: '...' },
    });
    FakeWS.last!.simulateMessage({
      type: 'event',
      serverId: 'srv-b',
      event: { Kind: 'PRIVMSG', From: 'eve', Target: '#general', Message: 'hi-b', Raw: '...' },
    });

    expect(aEvents.map((e) => e.Message)).toEqual(['hi-a']);
    expect(bEvents.map((e) => e.Message)).toEqual(['hi-b']);
  });

  it('updates the ServerSession state from server status messages', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const states: EngineState[] = [];
    session.onState((s) => states.push(s));

    FakeWS.last!.simulateMessage({ type: 'status', serverId: 's', state: 'connected' });
    expect(session.state()).toBe('connected');

    FakeWS.last!.simulateMessage({ type: 'status', serverId: 's', state: 'disconnected' });
    // Disconnected disposes the session.
    expect(session.isDisposed()).toBe(true);
    expect(client.getSession('s')).toBeNull();
    expect(states).toContain('connected');
    expect(states.at(-1)).toBe('disconnected');
  });

  it('per-server error messages call the ServerSession state listener with the error', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const observed: Array<{ state: EngineState; error?: string }> = [];
    session.onState((state, error) => observed.push({ state, error }));

    FakeWS.last!.simulateMessage({ type: 'error', serverId: 's', error: 'irc: hostname is required' });
    const last = observed.at(-1);
    expect(last?.error).toBe('irc: hostname is required');
  });

  it('transport-level errors (no serverId) reach onTransportError but not any session', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const sessionErrors: Array<string | undefined> = [];
    session.onState((_state, err) => sessionErrors.push(err));
    sessionErrors.length = 0;

    const transportErrors: string[] = [];
    client.onTransportError((e) => transportErrors.push(e));

    FakeWS.last!.simulateMessage({ type: 'error', error: 'bad json' });
    expect(transportErrors).toEqual(['bad json']);
    expect(sessionErrors).toEqual([]);
  });

  it('send before open notifies any open ServerSession with an error (no throw)', () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    // We can construct a session via the public surface only by calling
    // connect(); but connect itself routes through the not-open path. So
    // build one indirectly: open() not called, then connect() tries to send
    // and we observe the surfaced error on its onState listener.
    let observed: string | undefined;
    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    session.onState((_s, err) => { if (err) observed = err; });
    // Subsequent commands also fail loudly.
    expect(() => session.privmsg('#x', 'hi')).not.toThrow();
    expect(observed).toBe('engine: not connected');
  });

  it('open() failure marks sessions disconnected with the transport error', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const observed: Array<{ state: EngineState; error?: string }> = [];
    session.onState((state, error) => observed.push({ state, error }));

    FakeWS.last!.simulateError();
    expect(observed.some((o) => o.state === 'disconnected' && o.error === 'engine: websocket connection failed')).toBe(true);
  });

  it('after open() failure, isOpen() is false', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateError();
    await expect(p).rejects.toThrow();
    expect(client.isOpen()).toBe(false);
  });

  it('connect() called before open completes is queued and flushed on open', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    client.open(); // not awaited — readyState stays CONNECTING (0)

    expect(() => client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'alice' })).not.toThrow();
    expect(FakeWS.last!.sent).toHaveLength(0);

    FakeWS.last!.simulateOpen();
    expect(FakeWS.last!.sent).toHaveLength(1);
    expect(JSON.parse(FakeWS.last!.sent[0]!)).toMatchObject({ type: 'connect', params: { serverId: 's' } });
  });

  it('queued commands are dropped if the socket errors before opening', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'alice' });
    expect(FakeWS.last!.sent).toHaveLength(0);

    FakeWS.last!.simulateError();
    await expect(p).rejects.toThrow();
    expect(FakeWS.last!.sent).toHaveLength(0);
    expect(client.isOpen()).toBe(false);
  });

  it('close() releases the socket and disposes all sessions as disconnected', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;
    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const states: EngineState[] = [];
    session.onState((s) => states.push(s));
    client.close();
    expect(states).toContain('disconnected');
    expect(session.isDisposed()).toBe(true);
    expect(client.sessions()).toHaveLength(0);
  });

  it('onEvent returns an unsubscribe that stops further notifications', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const calls: IrcEvent[] = [];
    const unsub = session.onEvent((e) => calls.push(e));
    FakeWS.last!.simulateMessage({
      type: 'event',
      serverId: 's',
      event: { Kind: 'PRIVMSG', From: 'a', Target: '#x', Message: 'one', Raw: '' },
    });
    expect(calls).toHaveLength(1);
    unsub();
    FakeWS.last!.simulateMessage({
      type: 'event',
      serverId: 's',
      event: { Kind: 'PRIVMSG', From: 'a', Target: '#x', Message: 'two', Raw: '' },
    });
    expect(calls).toHaveLength(1);
  });

  it('join and privmsg on the ServerSession serialize the right shapes including serverId', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    FakeWS.last!.sent.length = 0;

    session.join('#test');
    session.privmsg('#test', 'hi');

    expect(JSON.parse(FakeWS.last!.sent[0]!)).toEqual({ type: 'join', params: { serverId: 's', channel: '#test' } });
    expect(JSON.parse(FakeWS.last!.sent[1]!)).toEqual({ type: 'privmsg', params: { serverId: 's', target: '#test', message: 'hi' } });
  });

  it('disconnect() on a ServerSession sends a per-server disconnect command', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const session = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    FakeWS.last!.sent.length = 0;
    session.disconnect();
    expect(JSON.parse(FakeWS.last!.sent[0]!)).toEqual({
      type: 'disconnect',
      params: { serverId: 's' },
    });
  });

  it('sessions() exposes all currently-open sessions; disposed sessions are dropped', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const a = client.connect({ serverId: 'a', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const b = client.connect({ serverId: 'b', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    expect(client.sessions().map((s) => s.serverId).sort()).toEqual(['a', 'b']);

    FakeWS.last!.simulateMessage({ type: 'status', serverId: 'a', state: 'disconnected' });
    expect(client.sessions().map((s) => s.serverId)).toEqual(['b']);
    expect(a.isDisposed()).toBe(true);
    expect(b.isDisposed()).toBe(false);
  });

  it('connect() on an already-open serverId returns the same ServerSession instance', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    const a1 = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const a2 = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    expect(a1).toBe(a2);
  });

  // Adoption path: when a session for the serverId is already live (e.g. the
  // owning bloc was destroyed but the engine connection is still up), calling
  // connect() again must NOT re-send a `connect` command. The engine rejects
  // duplicate connects, and a stray re-issue here previously left the
  // renderer-side state stuck on 'connecting' for an IRC client that was
  // actually already connected. This is the guest → signed-in transition.
  it('connect() does not re-send the connect command when adopting an existing session', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    // First connect — wire goes out, session is created.
    client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    expect(FakeWS.last!.sent).toHaveLength(1);
    // Advance the session to 'connected' as the engine would on RPL_WELCOME.
    FakeWS.last!.simulateMessage({ type: 'status', serverId: 's', state: 'connected' });

    // Second connect — should adopt, not re-issue.
    FakeWS.last!.sent.length = 0;
    const adopted = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    expect(FakeWS.last!.sent).toEqual([]);
    // State carries through — the adopted session is still 'connected', not
    // bumped back to 'connecting' as the old buggy code did.
    expect(adopted.state()).toBe('connected');
  });

  // Companion: subscribers attached AFTER adoption still receive the current
  // state synchronously (matches onState's general contract) so the renderer
  // can rebuild its connection view from a live session.
  it('onState() fires synchronously with the live state when adopting a session', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    FakeWS.last!.simulateMessage({ type: 'status', serverId: 's', state: 'connected' });

    const adopted = client.connect({ serverId: 's', hostname: 'irc', port: 6697, tls: true, nick: 'me' });
    const states: EngineState[] = [];
    adopted.onState((s) => states.push(s));
    expect(states).toEqual(['connected']);
  });
});

// Silence unused-import linter — vi is referenced for the type narrowing above.
void vi;
