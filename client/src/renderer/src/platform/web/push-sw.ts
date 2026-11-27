/// <reference lib="webworker" />
// The web client's push service worker (built to push-sw.js by the web
// build: vite.config.ts). Registered once per server by platform/web/push.ts
// as push-sw.js?s=<server id>&n=<server name> with scope push/<server id>/.
import { handleClick, handlePush } from './push-sw-core';
import { pushKV } from './push-idb';

declare const self: ServiceWorkerGlobalScope;

const q = new URL(self.location.href).searchParams;
const serverId = q.get('s') ?? '';
const serverName = q.get('n') ?? '';
const appUrl = new URL('../../', self.registration.scope).href;
const kv = pushKV(self.indexedDB);

const windows = async () => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) as WindowClient[];

self.addEventListener('install', () => { void self.skipWaiting(); });

self.addEventListener('push', (ev) => {
  const raw = ev.data?.text() ?? '';
  ev.waitUntil(handlePush(raw, {
    serverId, serverName, appUrl, kv,
    now: () => Date.now(),
    showNotification: (title, opts) => self.registration.showNotification(title, opts),
    getNotifications: (tag) => self.registration.getNotifications(tag ? { tag } : undefined),
    windows,
    openWindow: (url) => self.clients.openWindow(url),
  }).then(() => undefined, () => undefined));
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  ev.waitUntil(handleClick(ev.notification.data, { appUrl, windows, openWindow: (url) => self.clients.openWindow(url) }));
});
