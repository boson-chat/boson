// A TCP proxy between the app and the e2e ergo that can misbehave like a
// phone's network: add latency, go silent under the live connections (a
// phone that left Wi-Fi), cut them, refuse new ones (no network at all).
import { createConnection, createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { IRC_HOST, IRC_PORT } from '../fixtures';

export interface NetProxy {
  port: number;
  /** One-way delay added to everything, ms (0 = none). */
  latencyMs: number;
  /** New connections are accepted and closed at once. */
  refuse: boolean;
  /** The live connections carry nothing more either way, but stay open. */
  stallLive(): void;
  /** Cut every live connection. */
  drop(): void;
  close(): Promise<void>;
}

export async function startNetProxy(): Promise<NetProxy> {
  const live = new Set<Socket>();
  const stalled = new Set<Socket>();
  const proxy: NetProxy = {
    port: 0,
    latencyMs: 0,
    refuse: false,
    stallLive: () => { for (const s of live) stalled.add(s); },
    drop: () => { for (const s of live) s.destroy(); live.clear(); },
    close: () => new Promise<void>((resolve) => { proxy.drop(); server.close(() => resolve()); }),
  };
  // Same delay for every chunk, so timers keep their order.
  const relay = (from: Socket, to: Socket) => from.on('data', (b) => {
    if (stalled.has(from)) return;
    if (proxy.latencyMs > 0) setTimeout(() => { if (!to.destroyed) to.write(b); }, proxy.latencyMs);
    else to.write(b);
  });
  const server = createServer((client) => {
    if (proxy.refuse) { client.destroy(); return; }
    const upstream = createConnection({ host: IRC_HOST, port: IRC_PORT });
    live.add(client);
    live.add(upstream);
    const end = (): void => { client.destroy(); upstream.destroy(); live.delete(client); live.delete(upstream); };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
    relay(client, upstream);
    relay(upstream, client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy.port = (server.address() as AddressInfo).port;
  return proxy;
}
