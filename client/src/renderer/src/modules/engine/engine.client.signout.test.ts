import { describe, it, expect, beforeEach } from 'vitest';
import { EngineClient } from './engine.client';
import type { WebSocketLike, WebSocketCtor } from './engine.client';

class FakeWS implements WebSocketLike {
  static all: FakeWS[] = [];
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  sent: Array<{ type: string; params?: { serverId?: string } }> = [];
  constructor(public url: string) {
    FakeWS.all.push(this);
    // Opens on its own, like a reachable engine.
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event('open')); });
  }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  // The close event arrives later, after a new socket may be up.
  close(): void { this.readyState = 3; setTimeout(() => this.onclose?.(new CloseEvent('close')), 0); }
  push(m: unknown): void { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(m) })); }
}
const Ctor = FakeWS as unknown as WebSocketCtor;

describe('EngineClient.clearForSignOut', () => {
  beforeEach(() => { FakeWS.all = []; });

  it('disconnects every session, ends the engine session and opens a fresh one; nothing is adopted after', async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    await client.open();
    const ws = FakeWS.all[0]!;
    const a = client.connect({ serverId: 'a', hostname: 'irc', port: 6697, tls: true, nick: 'alice' });
    client.connect({ serverId: 'b', hostname: 'irc2', port: 6697, tls: true, nick: 'alice' });
    // The engine confirms a, never b.
    const done = client.clearForSignOut(100);
    expect(ws.sent.filter((c) => c.type === 'disconnect').map((c) => c.params?.serverId)).toEqual(['a', 'b']);
    ws.push({ type: 'status', serverId: 'a', state: 'disconnected' });
    await done;
    expect(a.isDisposed()).toBe(true);
    expect(client.sessions()).toEqual([]);
    expect(ws.readyState).toBe(3);
    expect(FakeWS.all).toHaveLength(2);
    expect(client.isOpen()).toBe(true);
    // The old socket's late close doesn't take the new one down.
    await new Promise((r) => setTimeout(r, 5));
    expect(client.isOpen()).toBe(true);
    // The next account's connect is a real connect on the new socket.
    const b2 = client.connect({ serverId: 'b', hostname: 'irc2', port: 6697, tls: true, nick: 'bob' });
    expect(b2.state()).toBe('connecting');
    expect(FakeWS.all[1]!.sent.map((c) => c.type)).toEqual(['connect']);
  });

  it("doesn't open an engine the app had closed", async () => {
    const client = new EngineClient({ url: 'ws://x', token: 't' }, Ctor);
    await client.open();
    client.close();
    await client.clearForSignOut(10);
    expect(FakeWS.all).toHaveLength(1);
    expect(client.isOpen()).toBe(false);
  });
});
