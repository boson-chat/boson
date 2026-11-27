// window.bosonPush in the web build (docs/push.md §3.2): the browser's own
// push service, no relay. Each server gets its own service worker
// registration (push-sw.js, scope push/<server id>/): a registration holds
// one subscription, bound to one VAPID key, and the worker then knows which
// server a push is from. The browser keeps the subscription's private key
// and decrypts pushes itself; the worker filters and shows them
// (push-sw-core.ts).
import { PushError, type PushBridge, type PushPermission, type PushSubscriptionInfo, type PushTarget } from '../../modules/push/push.types';
import { OPEN_MESSAGE } from './push-sw-core';
import { LIVE_EVERY_MS, liveKey, PREFS_KEY, pushKV, type PushKV } from './push-idb';

export function b64urlEncode(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

export interface WebPushDeps {
  // The app's base URL (document.baseURI).
  base: string;
  container?: ServiceWorkerContainer | null;
  kv?: PushKV;
  // Notification (permission, requestPermission).
  notification?: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> } | null;
  hasPushManager?: boolean;
  location?: { search: string; href: string };
  replaceUrl?: (url: string) => void;
  // e2e builds: returned instead of the browser's subscription.
  fakeSubscription?: PushSubscriptionInfo;
}

export function webPushBridge(deps: WebPushDeps): PushBridge {
  const container = deps.container === undefined ? (typeof navigator !== 'undefined' ? navigator.serviceWorker ?? null : null) : deps.container;
  const kv = deps.kv ?? pushKV();
  const note = deps.notification === undefined ? (typeof Notification !== 'undefined' ? Notification : null) : deps.notification;
  const hasPush = deps.hasPushManager ?? (typeof window !== 'undefined' && 'PushManager' in window);
  const scopeOf = (serverId: string): string => new URL(`push/${encodeURIComponent(serverId)}/`, deps.base).href;
  const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

  const activated = (reg: ServiceWorkerRegistration): Promise<void> => {
    if (reg.active) return Promise.resolve();
    const w = reg.installing ?? reg.waiting;
    if (!w) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new PushError('failed', 'The push worker didn’t start.')), 15_000);
      w.addEventListener('statechange', () => {
        if (w.state === 'activated') { clearTimeout(t); resolve(); }
        if (w.state === 'redundant') { clearTimeout(t); reject(new PushError('failed', 'The push worker didn’t start.')); }
      });
    });
  };

  const perm = (): PushPermission => (note?.permission === 'granted' || note?.permission === 'denied' ? note.permission : 'default');

  return {
    platform: 'web',
    needsRelay: false,

    async supported() {
      if (!container || !hasPush || !note) return 'This browser can’t receive push notifications.';
      return null;
    },

    async permission() { return perm(); },

    async requestPermission() {
      if (!note) return 'denied';
      try { await note.requestPermission(); } catch { /* old callback form */ }
      return perm();
    },

    async subscribe(t: PushTarget): Promise<PushSubscriptionInfo> {
      if (!container) throw new PushError('unsupported');
      if (perm() === 'denied') throw new PushError('denied');
      const script = new URL(`push-sw.js?s=${encodeURIComponent(t.serverId)}&n=${encodeURIComponent(t.serverName)}`, deps.base).href;
      let reg: ServiceWorkerRegistration;
      try {
        reg = await container.register(script, { scope: scopeOf(t.serverId) });
        await activated(reg);
      } catch (err) {
        throw err instanceof PushError ? err : new PushError('failed', err instanceof Error ? err.message : String(err));
      }
      if (deps.fakeSubscription) return deps.fakeSubscription;
      const key = b64urlDecode(t.vapid);
      try {
        let sub = await reg.pushManager.getSubscription();
        // Bound to another key (the server's VAPID key changed): start over.
        if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
          await sub.unsubscribe().catch(() => false);
          sub = null;
        }
        sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        return { endpoint: sub.endpoint, p256dh: b64urlEncode(sub.getKey('p256dh')), auth: b64urlEncode(sub.getKey('auth')) };
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'NotAllowedError') throw new PushError('denied');
        throw new PushError('failed', err instanceof Error ? err.message : String(err));
      }
    },

    async unsubscribe(serverId: string) {
      if (!container) return;
      try {
        const reg = await container.getRegistration(scopeOf(serverId));
        if (!reg) return;
        const sub = await reg.pushManager.getSubscription();
        await sub?.unsubscribe();
        await reg.unregister();
      } catch { /* best-effort */ }
      await kv.del(liveKey(serverId)).catch(() => {});
    },

    async syncPrefs(p) { await kv.set(PREFS_KEY, p); },

    setLive(serverId, live) {
      const prev = heartbeats.get(serverId);
      if (prev) clearInterval(prev);
      heartbeats.delete(serverId);
      if (!live) { void kv.del(liveKey(serverId)).catch(() => {}); return; }
      const beat = (): void => { void kv.set(liveKey(serverId), Date.now()).catch(() => {}); };
      beat();
      heartbeats.set(serverId, setInterval(beat, LIVE_EVERY_MS));
    },

    onOpen(fn) {
      if (!container) return () => {};
      const l = (ev: MessageEvent): void => {
        const d = ev.data as { type?: string; serverId?: string; conversation?: string } | null;
        if (d?.type === OPEN_MESSAGE && d.serverId) fn(d.serverId, d.conversation ?? '');
      };
      container.addEventListener('message', l as EventListener);
      // Messages from workers that don't control the page are held until
      // this is called.
      try { container.startMessages(); } catch { /* old browser */ }
      return () => container.removeEventListener('message', l as EventListener);
    },

    async consumeOpen() {
      const loc = deps.location ?? (typeof location !== 'undefined' ? location : null);
      if (!loc) return null;
      const u = new URL(loc.href);
      const serverId = u.searchParams.get('push-server');
      if (!serverId) return null;
      const conversation = u.searchParams.get('push-target') ?? '';
      u.searchParams.delete('push-server');
      u.searchParams.delete('push-target');
      const replace = deps.replaceUrl ?? ((url: string) => { try { history.replaceState(history.state, '', url); } catch { /* ignore */ } });
      replace(u.href);
      return { serverId, conversation };
    },
  };
}
