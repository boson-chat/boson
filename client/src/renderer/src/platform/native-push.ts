// window.bosonPush in the phone apps (docs/push.md §3.2): desktop/push.go's
// PushService — a relay mailbox per server, keys where the Notification
// Service Extension (iOS) / FCM service (Android) decrypt with them — and
// the notification permission from NotifyService (notify.go).
import { PushError, type PushBridge, type PushErrorCode, type PushPermission, type PushPlatform, type PushSubscriptionInfo } from '../modules/push/push.types';

export interface NativeCalls {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  on(event: string, fn: (data: unknown) => void): () => void;
}

const CODES: readonly PushErrorCode[] = ['no-relay', 'denied', 'unsupported', 'relay', 'failed'];

// Go errors come back as "<code>: <message>" (push.go pushErr), possibly
// wrapped by the runtime.
export function toPushError(err: unknown): PushError {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const m = /\b(no-relay|denied|unsupported|relay|failed): ([^"]*)/.exec(msg ?? '');
  if (m && CODES.includes(m[1] as PushErrorCode)) return new PushError(m[1] as PushErrorCode, m[2]);
  return new PushError('failed', msg || 'Push failed.');
}

const asPermission = (v: unknown): PushPermission => (v === 'granted' || v === 'denied' ? v : 'default');

function unwrap(d: unknown): Record<string, unknown> | null {
  const v = Array.isArray(d) ? d[0] : d;
  return v && typeof v === 'object' ? v as Record<string, unknown> : null;
}

export function nativePushBridge(platform: PushPlatform, c: NativeCalls): PushBridge {
  const P = 'main.PushService';
  const N = 'main.NotifyService';
  return {
    platform,
    needsRelay: true,
    async supported() { return ((await c.call(`${P}.Supported`)) as string) || null; },
    async permission() { return asPermission(await c.call(`${N}.Permission`)); },
    async requestPermission() { return asPermission(await c.call(`${N}.RequestPermission`)); },
    async relayFor(host) { return ((await c.call(`${P}.RelayFor`, host)) as string) || ''; },
    async subscribe(t) {
      try {
        const s = await c.call(`${P}.Subscribe`, t.serverId, t.serverName, t.host, t.vapid) as PushSubscriptionInfo | null;
        if (!s?.endpoint) throw new PushError('failed', 'No subscription.');
        return { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth };
      } catch (err) {
        throw err instanceof PushError ? err : toPushError(err);
      }
    },
    async unsubscribe(serverId) { await c.call(`${P}.Unsubscribe`, serverId).catch(() => {}); },
    async syncPrefs(p) { await c.call(`${P}.SyncPrefs`, JSON.stringify(p)); },
    onOpen(fn) {
      return c.on('push:open', (d) => {
        const o = unwrap(d);
        if (o && typeof o['serverId'] === 'string') fn(o['serverId'], typeof o['conversation'] === 'string' ? o['conversation'] : '');
      });
    },
    async consumeOpen() {
      const o = unwrap(await c.call(`${P}.ConsumeOpen`).catch(() => null));
      if (!o || typeof o['serverId'] !== 'string' || !o['serverId']) return null;
      return { serverId: o['serverId'], conversation: typeof o['conversation'] === 'string' ? o['conversation'] : '' };
    },
  };
}
