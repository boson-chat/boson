// What the web client's push service worker does (push-sw.ts wires it to
// the worker's events; split out to be tested). One worker per server
// (scope push/<server id>/), so a push says which server it's from; the
// browser has already decrypted it (RFC 8291) by the time it gets here.
import { parsePush, pushText, notificationTag } from '../../modules/push/payload';
import { cleanPrefs, shouldShowPush } from '../../modules/push/filter';
import { LIVE_FOR_MS, liveKey, PREFS_KEY, type PushKV } from './push-idb';

export interface SWNotification {
  tag: string;
  data?: unknown;
  close(): void;
}

export interface SWClient {
  url: string;
  focus?(): Promise<unknown>;
  postMessage(m: unknown): void;
}

export interface SWDeps {
  serverId: string;
  serverName: string;
  // The app's URL (the worker's scope minus push/<id>/).
  appUrl: string;
  kv: PushKV;
  now: () => number;
  showNotification(title: string, opts: NotificationOptions & { data: PushNotificationData }): Promise<void>;
  getNotifications(tag?: string): Promise<SWNotification[]>;
  windows(): Promise<SWClient[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface PushNotificationData {
  serverId: string;
  conversation: string;
  time?: string;
}

export const OPEN_MESSAGE = 'boson:push-open';

export async function handlePush(raw: string, d: SWDeps): Promise<'shown' | 'skipped' | 'read'> {
  const m = parsePush(raw);
  if (m.type === 'read') {
    const tag = notificationTag(d.serverId, m.target);
    for (const n of await d.getNotifications(tag)) {
      const at = (n.data as PushNotificationData | undefined)?.time;
      // Everything up to the read marker (all of it if either has no time).
      if (!m.time || !at || at <= m.time) n.close();
    }
    return 'read';
  }
  if (m.type !== 'message') return 'skipped';
  const prefs = cleanPrefs(await d.kv.get(PREFS_KEY).catch(() => undefined));
  if (!shouldShowPush(m, d.serverId, prefs)) return 'skipped';
  // A tab of the app has this server connected: it notifies by itself.
  const liveAt = await d.kv.get<number>(liveKey(d.serverId)).catch(() => undefined);
  if (typeof liveAt === 'number' && d.now() - liveAt < LIVE_FOR_MS) {
    const open = (await d.windows()).some((c) => c.url.startsWith(d.appUrl));
    if (open) return 'skipped';
  }
  const t = pushText(m, d.serverId, d.serverName);
  await d.showNotification(t.subtitle ? `${t.title} · ${t.subtitle}` : t.title, {
    body: t.body,
    tag: t.tag,
    // A new message in the same conversation alerts again.
    renotify: true,
    data: { serverId: d.serverId, conversation: m.conversation, ...(m.time ? { time: m.time } : {}) },
  } as NotificationOptions & { data: PushNotificationData });
  return 'shown';
}

// A notification clicked: focus a tab of the app and have it open the
// conversation, else open the app at it.
export async function handleClick(data: unknown, d: Pick<SWDeps, 'appUrl' | 'windows' | 'openWindow'>): Promise<void> {
  const nd = (data ?? {}) as Partial<PushNotificationData>;
  const serverId = nd.serverId ?? '';
  const conversation = nd.conversation ?? '';
  const app = (await d.windows()).find((c) => c.url.startsWith(d.appUrl));
  if (app) {
    try { await app.focus?.(); } catch { /* focus needs the click's activation; post anyway */ }
    app.postMessage({ type: OPEN_MESSAGE, serverId, conversation });
    return;
  }
  const u = new URL(d.appUrl);
  if (serverId) u.searchParams.set('push-server', serverId);
  if (conversation) u.searchParams.set('push-target', conversation);
  await d.openWindow(u.href);
}
