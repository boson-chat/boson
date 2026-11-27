// window.bosonPush: where push subscriptions come from on this platform
// (docs/push.md §3.2). The web build's is platform/web/push.ts (a service
// worker per server, the browser's push service); the phone apps' is
// platform/wails.ts over desktop/push.go (APNs / FCM through the Boson push
// relay). The desktop app has none yet (phase 2): it notifies while it runs.
import type { PushPrefs } from './filter';

export type PushPlatform = 'web' | 'ios' | 'android';

export type PushPermission = 'granted' | 'denied' | 'default';

// One server's subscription, as WEBPUSH REGISTER takes it.
export interface PushSubscriptionInfo {
  endpoint: string;
  // The device's P-256 public key (uncompressed point) and 16-byte auth
  // secret, base64url without padding.
  p256dh: string;
  auth: string;
}

export interface PushTarget {
  serverId: string;
  serverName: string;
  // The IRC host the server was reached at (the relay comes from its
  // domain's boson.json on phones).
  host: string;
  // The server's VAPID public key (ISUPPORT VAPID=), base64url.
  vapid: string;
}

// Why subscribe failed, for the settings row.
//   no-relay     the server's boson.json names no push relay (phones)
//   denied       notification permission refused
//   unsupported  this browser / device can't
//   relay        the relay refused or couldn't be reached
//   failed       anything else
export type PushErrorCode = 'no-relay' | 'denied' | 'unsupported' | 'relay' | 'failed';

export class PushError extends Error {
  constructor(readonly code: PushErrorCode, message?: string) {
    super(message || code);
  }
}

export interface PushBridge {
  platform: PushPlatform;
  // Phones push through a relay named in the server's boson.json.
  needsRelay: boolean;
  // Whether the platform can push at all (null: yes; else why not).
  supported(): Promise<string | null>;
  permission(): Promise<PushPermission>;
  // Asks once; a user gesture on the web.
  requestPermission(): Promise<PushPermission>;
  // Phones: the relay this server's boson.json recommends ('' = none).
  relayFor?(host: string): Promise<string>;
  // A subscription for this server (made, or the one already there when it
  // still matches the VAPID key). Throws PushError.
  subscribe(t: PushTarget): Promise<PushSubscriptionInfo>;
  // Drops the server's subscription: the browser's, or the relay mailbox
  // and the keys (phones). Best-effort; never throws.
  unsubscribe(serverId: string): Promise<void>;
  // The settings the receiver filters by (filter.ts), mirrored where it can
  // read them (IndexedDB / the App Group / shared preferences).
  syncPrefs(p: PushPrefs): Promise<void>;
  // This page has the server's IRC connection up (the receiver then leaves
  // its messages to the page's own notifications). Optional.
  setLive?(serverId: string, live: boolean): void;
  // A push notification was opened: the server and conversation.
  onOpen(fn: (serverId: string, conversation: string) => void): () => void;
  // One opened before the app was running (a cold start). Once.
  consumeOpen(): Promise<{ serverId: string; conversation: string } | null>;
}

export function pushBridge(): PushBridge | null {
  return (globalThis as { bosonPush?: PushBridge }).bosonPush ?? null;
}
