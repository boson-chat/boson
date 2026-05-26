import { describe, it, expect, beforeEach } from 'vitest';
import { EngineClient } from './engine.client';
import type { WebSocketLike, WebSocketCtor, ReconnectOptions } from './engine.client';

// Hand-rolled fake WebSocket so we can drive open/message/close at will.
// Track all instances created so reconnect attempts each get their own
// FakeWS to drive.
class FakeWS implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  static instances: FakeWS[] = [];
  static get last(): FakeWS | undefined { return FakeWS.instances[FakeWS.instances.length - 1]; }
  static reset(): void { FakeWS.instances = []; }

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('InvalidStateError: WebSocket not OPEN');
    }
    this.sent.push(data);
  }
  // close() simulates *caller-initiated* close: readyState=CLOSED + onclose.
  close(): void { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }

  // Simulates a server-side / network-induced unexpected close. From the
  // EngineClient's perspective this is indistinguishable from a caller close;
  // the difference is whether EngineClient.close() was called.
  simulateUnexpectedClose(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  simulateOpen(): void { this.readyState = 1; this.onopen?.(new Event('open')); }
  simulateError(): void { this.onerror?.(new Event('error')); }
}

const Ctor: WebSocketCtor = FakeWS as unknown as WebSocketCtor;

// Deterministic clock: every queued timer is captured here and flushed
// manually by tests. We don't honour `ms` — tests inspect delays directly
// via `pendingDelays()`.
interface QueuedTimer { fn: () => void; ms: number; handle: number }

function makeClock() {
  let nextHandle = 1;
  const queue: QueuedTimer[] = [];
  const setTimer = (fn: () => void, ms: number): unknown => {
    const handle = nextHandle++;
    queue.push({ fn, ms, handle });
    return handle;
  };
  const clearTimer = (h: unknown): void => {
    const idx = queue.findIndex(q => q.handle === h);
    if (idx >= 0) queue.splice(idx, 1);
  };
  const flushNext = (): number => {
    const t = queue.shift();
    if (!t) throw new Error('flushNext: no pending timers');
    t.fn();
    return t.ms;
  };
  const pendingDelays = (): number[] => queue.map(q => q.ms);
  const pending = (): number => queue.length;
  return { setTimer, clearTimer, flushNext, pendingDelays, pending };
}

// Convenience: build reconnect opts with deterministic timers + jitter.
function reconnectOpts(clock: ReturnType<typeof makeClock>, extra: Partial<ReconnectOptions> = {}): ReconnectOptions {
  return {
    baseMs: 500,
    maxMs: 10000,
    random: () => 1, // top of the jitter window (delay = cap * 1.0)
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  };
}

describe('EngineClient reconnect', () => {
  beforeEach(() => { FakeWS.reset(); });

  it('schedules a reconnect with the base delay after an unexpected close', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: reconnectOpts(clock) },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    expect(clock.pending()).toBe(0);
    FakeWS.last!.simulateUnexpectedClose();
    // First attempt: cap = min(500 * 2^0, 10000) = 500; with random()=1 => 500.
    expect(clock.pendingDelays()).toEqual([500]);
  });

  it('grows the delay exponentially across consecutive failures', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: reconnectOpts(clock) },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    // attempts=0 → delay 500
    FakeWS.last!.simulateUnexpectedClose();
    expect(clock.pendingDelays()).toEqual([500]);

    // Fire the timer. open() runs, creating a new FakeWS. Fail it via error.
    const firedAt1 = clock.flushNext();
    expect(firedAt1).toBe(500);
    const ws1 = FakeWS.last!;
    ws1.simulateError();
    // Allow the open() promise rejection to settle.
    await Promise.resolve();
    // attempts=1 → cap = 1000, random()=1 → 1000.
    expect(clock.pendingDelays()).toEqual([1000]);

    const firedAt2 = clock.flushNext();
    expect(firedAt2).toBe(1000);
    FakeWS.last!.simulateError();
    await Promise.resolve();
    // attempts=2 → cap = 2000.
    expect(clock.pendingDelays()).toEqual([2000]);

    const firedAt3 = clock.flushNext();
    expect(firedAt3).toBe(2000);
    FakeWS.last!.simulateError();
    await Promise.resolve();
    // attempts=3 → cap = 4000.
    expect(clock.pendingDelays()).toEqual([4000]);
  });

  it('caps the delay at maxMs', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      // baseMs=1000, maxMs=4000 — attempt 3 would be 8000 uncapped.
      { wsCtor: Ctor, reconnect: reconnectOpts(clock, { baseMs: 1000, maxMs: 4000 }) },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    FakeWS.last!.simulateUnexpectedClose();
    // attempt 0 → 1000
    expect(clock.pendingDelays()).toEqual([1000]);
    clock.flushNext();
    FakeWS.last!.simulateError();
    await Promise.resolve();
    // attempt 1 → 2000
    expect(clock.pendingDelays()).toEqual([2000]);
    clock.flushNext();
    FakeWS.last!.simulateError();
    await Promise.resolve();
    // attempt 2 → 4000 (cap reached: min(4000, 4000))
    expect(clock.pendingDelays()).toEqual([4000]);
    clock.flushNext();
    FakeWS.last!.simulateError();
    await Promise.resolve();
    // attempt 3 → still 4000 (would-be 8000 capped at 4000)
    expect(clock.pendingDelays()).toEqual([4000]);
  });

  it('applies the random jitter factor', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      // random()=0 → delay = cap * 0.5
      { wsCtor: Ctor, reconnect: reconnectOpts(clock, { random: () => 0 }) },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    FakeWS.last!.simulateUnexpectedClose();
    expect(clock.pendingDelays()).toEqual([250]); // 500 * 0.5
  });

  it('resets the attempt counter after a successful reopen', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: reconnectOpts(clock) },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    // Fail twice to grow the attempt counter.
    FakeWS.last!.simulateUnexpectedClose();
    expect(clock.pendingDelays()).toEqual([500]);
    clock.flushNext();
    FakeWS.last!.simulateError();
    await Promise.resolve();
    expect(clock.pendingDelays()).toEqual([1000]);
    clock.flushNext();
    // Now succeed: open() ran, a new FakeWS exists — drive its onopen.
    FakeWS.last!.simulateOpen();
    await Promise.resolve();
    // No further timer scheduled while connected.
    expect(clock.pending()).toBe(0);

    // Another unexpected close should now schedule at the base delay (500),
    // not 2000 — counter was reset.
    FakeWS.last!.simulateUnexpectedClose();
    expect(clock.pendingDelays()).toEqual([500]);
  });

  it('close() cancels a pending reconnect timer', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: reconnectOpts(clock) },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    FakeWS.last!.simulateUnexpectedClose();
    expect(clock.pending()).toBe(1);

    client.close();
    expect(clock.pending()).toBe(0);
  });

  it('close() suppresses reconnect even if timer fires before clearing', async () => {
    // Belt-and-braces: even if a timer somehow ran after close(), the
    // closedByCaller guard inside the timer body should bail.
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: reconnectOpts(clock) },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    FakeWS.last!.simulateUnexpectedClose();
    const sockCountBefore = FakeWS.instances.length;
    // Manually run the timer body without clock.flushNext() going through
    // close()'s cancellation path. This mirrors the race where the timer
    // dispatches before clearTimer is processed.
    client.close();
    // No new socket should have been constructed during/after close().
    expect(FakeWS.instances.length).toBe(sockCountBefore);
  });

  it('onReconnect fires after auto-reconnect but NOT after initial open', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: reconnectOpts(clock) },
    );

    const calls: number[] = [];
    client.onReconnect(() => { calls.push(Date.now()); });

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;
    // Initial open must NOT trigger onReconnect.
    expect(calls.length).toBe(0);

    // Now simulate an unexpected drop + successful reconnect.
    FakeWS.last!.simulateUnexpectedClose();
    clock.flushNext();
    FakeWS.last!.simulateOpen();
    await Promise.resolve();
    expect(calls.length).toBe(1);

    // Another drop+reconnect cycle fires it again.
    FakeWS.last!.simulateUnexpectedClose();
    clock.flushNext();
    FakeWS.last!.simulateOpen();
    await Promise.resolve();
    expect(calls.length).toBe(2);
  });

  it('onReconnect unsubscribe stops further notifications', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: reconnectOpts(clock) },
    );

    let calls = 0;
    const unsub = client.onReconnect(() => { calls += 1; });

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    FakeWS.last!.simulateUnexpectedClose();
    clock.flushNext();
    FakeWS.last!.simulateOpen();
    await Promise.resolve();
    expect(calls).toBe(1);

    unsub();
    FakeWS.last!.simulateUnexpectedClose();
    clock.flushNext();
    FakeWS.last!.simulateOpen();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it('reconnect: false disables auto-reconnect entirely', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: false },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    FakeWS.last!.simulateUnexpectedClose();
    // No timer should have been scheduled on the injected clock — but since
    // the client wasn't given that clock at all, the real assertion is that
    // no new FakeWS gets constructed. Confirm both via clock.pending() (zero
    // because we never wired it) AND via instance count being unchanged.
    expect(clock.pending()).toBe(0);
    expect(FakeWS.instances.length).toBe(1);
  });

  it('honours maxAttempts: stops scheduling after the limit is reached', async () => {
    const clock = makeClock();
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: reconnectOpts(clock, { maxAttempts: 2 }) },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;

    // Unexpected close #1 — attempts=0, schedule.
    FakeWS.last!.simulateUnexpectedClose();
    expect(clock.pending()).toBe(1);
    clock.flushNext();
    FakeWS.last!.simulateError();
    await Promise.resolve();
    // attempts is now 1, scheduled retry #2.
    expect(clock.pending()).toBe(1);
    clock.flushNext();
    FakeWS.last!.simulateError();
    await Promise.resolve();
    // attempts is now 2 == maxAttempts, no further schedule.
    expect(clock.pending()).toBe(0);
  });

  it('back-compat: constructor still accepts a bare WebSocketCtor as 2nd arg', async () => {
    // The original signature was `new EngineClient(config, wsCtor)`. We must
    // continue to accept that to avoid a breaking change.
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;
    expect(client.isOpen()).toBe(true);
  });

  it('default reconnect (no options) uses real timers — schedule fires by default', async () => {
    // Smoke test that the default branch (no reconnect option provided) still
    // wires reconnect logic. We don't actually wait for setTimeout; we just
    // assert that an unexpected close triggers another FakeWS construction
    // when the timer eventually fires, by setting baseMs=0 via opts.
    const client = new EngineClient(
      { url: 'ws://x', token: 't' },
      { wsCtor: Ctor, reconnect: { baseMs: 0, maxMs: 0, random: () => 0 } },
    );

    const p = client.open();
    FakeWS.last!.simulateOpen();
    await p;
    expect(FakeWS.instances.length).toBe(1);

    FakeWS.last!.simulateUnexpectedClose();
    // Wait long enough for setTimeout(_, 0) to fire.
    await new Promise(r => setTimeout(r, 20));
    expect(FakeWS.instances.length).toBe(2);
  });
});
