import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushManager, PUSH_STORAGE_KEY, type PushServer, type PushSession } from './push.manager';
import { DEFAULT_PUSH_PREFS } from './filter';
import { PushError, type PushBridge, type PushTarget } from './push.types';
import type { EngineState, IrcEvent } from '../engine/engine.types';

class FakeSession implements PushSession {
  lines: string[] = [];
  private evs = new Set<(e: IrcEvent) => void>();
  private sts = new Set<(s: EngineState) => void>();
  st: EngineState = 'connecting';
  onEvent(fn: (e: IrcEvent) => void) { this.evs.add(fn); return () => { this.evs.delete(fn); }; }
  onState(fn: (s: EngineState) => void) { this.sts.add(fn); return () => { this.sts.delete(fn); }; }
  state() { return this.st; }
  raw(line: string) { this.lines.push(line); }
  emit(Kind: string, rest: Partial<IrcEvent> = {}) { for (const f of this.evs) f({ Kind, From: 'irc.test', Target: 'bob', Message: '', Raw: '', ...rest }); }
  setState(s: EngineState) { this.st = s; for (const f of this.sts) f(s); }
  // A Boson Ergo's registration: webpush ACKed, VAPID advertised.
  welcome(vapid: string | null = 'BVAPID', cap = true) {
    this.setState('connected');
    if (cap) this.emit('CAP', { Args: ['ACK'], Message: 'message-tags draft/webpush' });
    this.emit('001');
    this.emit('005', { Args: vapid ? ['NETWORK=Test', `VAPID=${vapid}`] : ['NETWORK=Test'] });
    this.emit('376');
  }
}

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    map: m,
  };
}

function fakeBridge(over: Partial<PushBridge> = {}) {
  const subscribed: PushTarget[] = [];
  const unsubscribed: string[] = [];
  const prefs: unknown[] = [];
  const live: Array<[string, boolean]> = [];
  let open: ((s: string, c: string) => void) | null = null;
  const b: PushBridge = {
    platform: 'web',
    needsRelay: false,
    supported: async () => null,
    permission: async () => 'granted',
    requestPermission: async () => 'granted',
    subscribe: async (t) => { subscribed.push(t); return { endpoint: `https://push.example/${t.serverId}`, p256dh: 'PUB', auth: 'AUTH' }; },
    unsubscribe: async (id) => { unsubscribed.push(id); },
    syncPrefs: async (p) => { prefs.push(p); },
    setLive: (id, on) => { live.push([id, on]); },
    onOpen: (fn) => { open = fn; return () => { open = null; }; },
    consumeOpen: async () => null,
    ...over,
  };
  return { b, subscribed, unsubscribed, prefs, live, open: (s: string, c: string) => open?.(s, c) };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function server(session: FakeSession, over: Partial<PushServer> = {}): PushServer {
  return { serverId: 's1', serverName: 'Test', host: 'irc.test.example', boson: true, viaBouncer: false, signedIn: true, session, ...over };
}

describe('PushManager', () => {
  let storage: ReturnType<typeof memStorage>;
  beforeEach(() => { storage = memStorage(); });
  afterEach(() => { vi.useRealTimers(); });

  async function setup(over: Partial<PushBridge> = {}) {
    const f = fakeBridge(over);
    const m = new PushManager({ bridge: f.b, storage, prefs: () => DEFAULT_PUSH_PREFS, vapidWaitMs: 50, registerTimeoutMs: 200 });
    await m.start();
    return { m, ...f };
  }

  it('registers on connect with the browser endpoint and keys, and is on once the server answers', async () => {
    const { m, subscribed, live } = await setup();
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    expect(subscribed).toEqual([{ serverId: 's1', serverName: 'Test', host: 'irc.test.example', vapid: 'BVAPID' }]);
    expect(s.lines).toEqual(['WEBPUSH REGISTER https://push.example/s1 p256dh=PUB;auth=AUTH']);
    expect(m.status('s1')).toEqual({ state: 'pending' });
    s.emit('WEBPUSH', { Args: ['REGISTER', 'https://push.example/s1', 'p256dh=PUB;auth=AUTH'] });
    expect(m.status('s1')).toEqual({ state: 'on' });
    expect(JSON.parse(storage.getItem(PUSH_STORAGE_KEY)!)).toEqual({ s1: { endpoint: 'https://push.example/s1' } });
    expect(live).toContainEqual(['s1', true]);
  });

  it('registers again on every connect (renews the expiry)', async () => {
    const { m } = await setup();
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    s.emit('WEBPUSH', { Args: ['REGISTER', 'https://push.example/s1'] });
    s.setState('disconnected');
    expect(m.status('s1')).toEqual({ state: 'pending' });
    s.welcome();
    await flush();
    expect(s.lines.filter((l) => l.startsWith('WEBPUSH REGISTER'))).toHaveLength(2);
  });

  it('a server without webpush is unavailable, and nothing is sent', async () => {
    const { m, subscribed } = await setup();
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome(null, false);
    await flush();
    expect(m.status('s1').state).toBe('unavailable');
    expect(subscribed).toHaveLength(0);
    expect(s.lines).toHaveLength(0);
  });

  it('waits for VAPID= until the end of the burst (or a timeout)', async () => {
    const { m, subscribed } = await setup();
    const s = new FakeSession();
    m.attach(server(s));
    s.setState('connected');
    s.emit('CAP', { Args: ['ACK'], Message: 'draft/webpush' });
    s.emit('001');
    await new Promise((r) => setTimeout(r, 80));
    expect(m.factsFor('s1')?.vapid).toBe('');
    expect(m.status('s1').state).toBe('unavailable');
    expect(subscribed).toHaveLength(0);
  });

  it('guests get "sign in"; plain IRC and bouncers get no row', async () => {
    const { m } = await setup();
    const a = new FakeSession(), b = new FakeSession(), c = new FakeSession();
    m.attach(server(a, { serverId: 'guest', signedIn: false }));
    m.attach(server(b, { serverId: 'plain', boson: false }));
    m.attach(server(c, { serverId: 'znc', viaBouncer: true }));
    for (const s of [a, b, c]) s.welcome();
    await flush();
    expect(m.rows()).toEqual([{ serverId: 'guest', serverName: 'Test', status: { state: 'sign-in' } }]);
    expect([...a.lines, ...b.lines, ...c.lines]).toEqual([]);
  });

  it('a FAIL from the server says why', async () => {
    const { m } = await setup();
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    s.emit('FAIL', { Args: ['WEBPUSH', 'INVALID_PARAMS', 'REGISTER', 'https://push.example/s1'], Message: 'Test push message failed to send' });
    expect(m.status('s1')).toEqual({ state: 'unavailable', reason: 'Test push message failed to send' });
  });

  it('no answer is a failure too', async () => {
    const { m } = await setup();
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    await new Promise((r) => setTimeout(r, 250));
    expect(m.status('s1')).toEqual({ state: 'unavailable', reason: 'No answer from the server.' });
  });

  it('turning it off unregisters, drops the subscription and stays off', async () => {
    const { m, unsubscribed } = await setup();
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    s.emit('WEBPUSH', { Args: ['REGISTER', 'https://push.example/s1'] });
    await m.setEnabled('s1', false);
    expect(s.lines.at(-1)).toBe('WEBPUSH UNREGISTER https://push.example/s1');
    expect(unsubscribed).toEqual(['s1']);
    expect(m.status('s1')).toEqual({ state: 'off' });
    expect(JSON.parse(storage.getItem(PUSH_STORAGE_KEY)!)).toEqual({ s1: { off: true } });
    // Next connect: still off.
    s.setState('disconnected');
    s.welcome();
    await flush();
    expect(s.lines.filter((l) => l.startsWith('WEBPUSH REGISTER'))).toHaveLength(1);
    // And on again.
    await m.setEnabled('s1', true);
    await flush();
    expect(s.lines.filter((l) => l.startsWith('WEBPUSH REGISTER'))).toHaveLength(2);
  });

  it('turning on asks for permission first', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const);
    const { m } = await setup({ permission: async () => 'default', requestPermission });
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    expect(m.status('s1')).toEqual({ state: 'off', needsPermission: true });
    expect(s.lines).toEqual([]);
    await m.setEnabled('s1', true);
    await flush();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(s.lines[0]).toMatch(/^WEBPUSH REGISTER /);
  });

  it('removing the server, even while it is unreachable, deletes the subscription', async () => {
    const { m, unsubscribed } = await setup();
    storage.setItem(PUSH_STORAGE_KEY, JSON.stringify({ s1: { endpoint: 'https://push.example/s1' } }));
    const s = new FakeSession();
    m.attach(server(s));
    s.setState('disconnected');
    await m.forget('s1');
    expect(s.lines).toEqual([]);
    expect(unsubscribed).toEqual(['s1']);
    expect(storage.getItem(PUSH_STORAGE_KEY)).toBeNull();
    expect(m.rows()).toEqual([]);
  });

  it('sign-out unregisters everywhere and forgets every server', async () => {
    const { m, unsubscribed } = await setup();
    storage.setItem(PUSH_STORAGE_KEY, JSON.stringify({ gone: { endpoint: 'https://push.example/gone' } }));
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    s.emit('WEBPUSH', { Args: ['REGISTER', 'https://push.example/s1'] });
    await m.clearForSignOut();
    expect(s.lines.at(-1)).toBe('WEBPUSH UNREGISTER https://push.example/s1');
    expect(unsubscribed.sort()).toEqual(['gone', 's1']);
    expect(storage.getItem(PUSH_STORAGE_KEY)).toBeNull();
  });

  it('back as a guest after being subscribed: the subscription goes', async () => {
    const { m, unsubscribed } = await setup();
    storage.setItem(PUSH_STORAGE_KEY, JSON.stringify({ s1: { endpoint: 'https://push.example/s1' } }));
    m.attach(server(new FakeSession(), { signedIn: false }));
    await flush();
    expect(unsubscribed).toEqual(['s1']);
    expect(storage.getItem(PUSH_STORAGE_KEY)).toBeNull();
  });

  it('a new endpoint (the VAPID key changed) unregisters the old one', async () => {
    let n = 0;
    const { m } = await setup({ subscribe: async () => ({ endpoint: `https://push.example/e${++n}`, p256dh: 'P', auth: 'A' }) });
    storage.setItem(PUSH_STORAGE_KEY, JSON.stringify({ s1: { endpoint: 'https://push.example/old' } }));
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    expect(s.lines).toEqual(['WEBPUSH UNREGISTER https://push.example/old', 'WEBPUSH REGISTER https://push.example/e1 p256dh=P;auth=A']);
  });

  describe('phones', () => {
    it('look up the relay and register its mailbox', async () => {
      const relayFor = vi.fn(async () => 'https://push.boson.chat');
      const { m, subscribed } = await setup({ platform: 'ios', needsRelay: true, relayFor });
      const s = new FakeSession();
      m.attach(server(s));
      s.welcome();
      await flush();
      expect(relayFor).toHaveBeenCalledWith('irc.test.example');
      expect(subscribed).toHaveLength(1);
    });
    it('without a relay: unavailable on phones', async () => {
      const { m, subscribed } = await setup({ platform: 'android', needsRelay: true, relayFor: async () => '' });
      const s = new FakeSession();
      m.attach(server(s));
      s.welcome();
      await flush();
      expect(m.status('s1').state).toBe('unavailable');
      expect(subscribed).toHaveLength(0);
    });
    it('a refused permission while subscribing', async () => {
      const { m } = await setup({ platform: 'ios', needsRelay: true, relayFor: async () => 'https://r', subscribe: async () => { throw new PushError('denied'); } });
      const s = new FakeSession();
      m.attach(server(s));
      s.welcome();
      await flush();
      expect(m.status('s1').state).toBe('unavailable');
      expect(s.lines).toEqual([]);
    });
  });

  it('mirrors the settings and passes opened notifications on', async () => {
    const { m, prefs, open } = await setup();
    expect(prefs).toHaveLength(1);
    const opened: Array<[string, string]> = [];
    m.onOpen((sv, c) => opened.push([sv, c]));
    open('s1', '#team');
    expect(opened).toEqual([['s1', '#team']]);
  });

  it('a cold-start open is delivered once started', async () => {
    const f = fakeBridge({ consumeOpen: async () => ({ serverId: 's1', conversation: 'alice' }) });
    const m = new PushManager({ bridge: f.b, storage, prefs: () => DEFAULT_PUSH_PREFS });
    const opened: string[] = [];
    m.onOpen((_s, c) => opened.push(c));
    await m.start();
    expect(opened).toEqual(['alice']);
  });

  it('without a bridge (desktop) signed-in Boson servers say why', async () => {
    const m = new PushManager({ bridge: null, storage });
    await m.start();
    const s = new FakeSession();
    m.attach(server(s));
    s.welcome();
    await flush();
    expect(m.status('s1').state).toBe('unavailable');
    expect(s.lines).toEqual([]);
  });
});
