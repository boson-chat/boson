import { describe, expect, it, vi } from 'vitest';
import { b64urlDecode, b64urlEncode, webPushBridge } from './push';
import { pushKV } from './push-idb';
import { PushError } from '../../modules/push/push.types';
import { OPEN_MESSAGE } from './push-sw-core';

const VAPID = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

function fakeContainer(existing: { key: Uint8Array } | null = null) {
  const calls: string[] = [];
  let sub: { endpoint: string; options: { applicationServerKey: ArrayBuffer | null }; getKey(n: string): ArrayBuffer; unsubscribe: () => Promise<boolean> } | null = null;
  const makeSub = (key: Uint8Array, endpoint: string) => ({
    endpoint,
    options: { applicationServerKey: key.slice().buffer as ArrayBuffer },
    getKey: (n: string) => new Uint8Array(n === 'p256dh' ? [4, 1, 2] : [9, 9]).buffer as ArrayBuffer,
    unsubscribe: async () => { calls.push(`unsubscribe ${endpoint}`); sub = null; return true; },
  });
  if (existing) sub = makeSub(existing.key, 'https://fcm.example/old');
  const reg = {
    active: {},
    pushManager: {
      getSubscription: async () => sub,
      subscribe: async (o: { applicationServerKey: Uint8Array }) => { calls.push('subscribe'); sub = makeSub(o.applicationServerKey, 'https://fcm.example/new'); return sub; },
    },
    unregister: async () => { calls.push('unregister'); return true; },
  };
  const listeners: Array<(e: MessageEvent) => void> = [];
  const c = {
    register: vi.fn(async (url: string, o: { scope: string }) => { calls.push(`register ${url} ${o.scope}`); return reg; }),
    getRegistration: async (scope: string) => { calls.push(`get ${scope}`); return reg; },
    addEventListener: (_t: string, l: (e: MessageEvent) => void) => { listeners.push(l); },
    removeEventListener: () => {},
    startMessages: () => {},
  };
  return { c: c as unknown as ServiceWorkerContainer, calls, send: (data: unknown) => listeners.forEach((l) => l({ data } as MessageEvent)) };
}

const granted = { permission: 'granted' as NotificationPermission, requestPermission: async () => 'granted' as NotificationPermission };

describe('base64url', () => {
  it('round-trips', () => {
    expect(b64urlEncode(b64urlDecode(VAPID).buffer as ArrayBuffer)).toBe(VAPID);
  });
});

describe('webPushBridge', () => {
  it('registers a worker per server and subscribes with the server’s VAPID key', async () => {
    const f = fakeContainer();
    const b = webPushBridge({ base: 'https://chat.example/', container: f.c, notification: granted, hasPushManager: true, kv: pushKV(undefined) });
    expect(await b.supported()).toBeNull();
    const sub = await b.subscribe({ serverId: 'srv/1', serverName: 'Boson HQ', host: 'irc.example', vapid: VAPID });
    expect(f.calls).toEqual(['register https://chat.example/push-sw.js?s=srv%2F1&n=Boson%20HQ https://chat.example/push/srv%2F1/', 'subscribe']);
    expect(sub).toEqual({ endpoint: 'https://fcm.example/new', p256dh: 'BAEC', auth: 'CQk' });
  });

  it('keeps a subscription for the same key, replaces one for another', async () => {
    const same = fakeContainer({ key: b64urlDecode(VAPID) });
    const b1 = webPushBridge({ base: 'https://chat.example/', container: same.c, notification: granted, hasPushManager: true, kv: pushKV(undefined) });
    expect((await b1.subscribe({ serverId: 's', serverName: 'S', host: 'h', vapid: VAPID })).endpoint).toBe('https://fcm.example/old');
    const other = fakeContainer({ key: new Uint8Array([1, 2, 3]) });
    const b2 = webPushBridge({ base: 'https://chat.example/', container: other.c, notification: granted, hasPushManager: true, kv: pushKV(undefined) });
    expect((await b2.subscribe({ serverId: 's', serverName: 'S', host: 'h', vapid: VAPID })).endpoint).toBe('https://fcm.example/new');
    expect(other.calls).toContain('unsubscribe https://fcm.example/old');
  });

  it('refuses when notifications are blocked; unsupported without a push manager', async () => {
    const f = fakeContainer();
    const b = webPushBridge({ base: 'https://chat.example/', container: f.c, notification: { permission: 'denied', requestPermission: async () => 'denied' }, hasPushManager: true, kv: pushKV(undefined) });
    await expect(b.subscribe({ serverId: 's', serverName: 'S', host: 'h', vapid: VAPID })).rejects.toEqual(new PushError('denied'));
    const none = webPushBridge({ base: 'https://chat.example/', container: null, notification: granted, hasPushManager: false });
    expect(await none.supported()).toMatch(/can’t receive/);
  });

  it('unsubscribe drops the subscription and the worker', async () => {
    const f = fakeContainer({ key: b64urlDecode(VAPID) });
    const b = webPushBridge({ base: 'https://chat.example/', container: f.c, notification: granted, hasPushManager: true, kv: pushKV(undefined) });
    await b.unsubscribe('s1');
    expect(f.calls).toEqual(['get https://chat.example/push/s1/', 'unsubscribe https://fcm.example/old', 'unregister']);
  });

  it('passes on clicks from the workers and reads a cold-start open from the URL', async () => {
    const f = fakeContainer();
    let replaced = '';
    const b = webPushBridge({
      base: 'https://chat.example/', container: f.c, notification: granted, hasPushManager: true, kv: pushKV(undefined),
      location: { search: '', href: 'https://chat.example/?push-server=s1&push-target=%23team&x=1' }, replaceUrl: (u) => { replaced = u; },
    });
    const got: string[] = [];
    b.onOpen((s, c) => got.push(`${s} ${c}`));
    f.send({ type: OPEN_MESSAGE, serverId: 's1', conversation: 'alice' });
    f.send({ type: 'other' });
    expect(got).toEqual(['s1 alice']);
    expect(await b.consumeOpen()).toEqual({ serverId: 's1', conversation: '#team' });
    expect(replaced).toBe('https://chat.example/?x=1');
  });

  it('mirrors the settings and the live heartbeat', async () => {
    vi.useFakeTimers();
    const kv = pushKV(undefined);
    const b = webPushBridge({ base: 'https://chat.example/', container: fakeContainer().c, notification: granted, hasPushManager: true, kv });
    await b.syncPrefs({ v: 1, enabled: false, mentions: true, directMessages: true, servers: {}, levels: {} });
    expect(await kv.get('prefs')).toMatchObject({ enabled: false });
    b.setLive!('s1', true);
    await Promise.resolve();
    expect(typeof await kv.get('live:s1')).toBe('number');
    b.setLive!('s1', false);
    await Promise.resolve();
    expect(await kv.get('live:s1')).toBeUndefined();
    vi.useRealTimers();
  });
});
