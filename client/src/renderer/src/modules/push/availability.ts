// Which servers offer push, and what Settings → Notifications says about
// each (docs/push.md §3.1, §3.2 step 5). Pure: the manager (push.manager.ts)
// gathers the facts, this decides.
import type { PushPermission, PushPlatform } from './push.types';

export interface PushFacts {
  // null: this build has no push (the desktop app, for now).
  platform: PushPlatform | null;
  // Why the platform can't push (an old browser, …); null when it can.
  unsupported?: string | null;
  // The network runs the Boson stack (its boson.json names an auth service).
  boson: boolean;
  // Connected through the user's own bouncer: not offered (§ Decisions).
  viaBouncer: boolean;
  // Logged in with that network's Boson account (local or federated), not
  // a guest.
  signedIn: boolean;
  // What the IRC server said, once registration is through: whether it
  // ACKed draft/webpush, and its VAPID= key. null: not known yet.
  cap: boolean | null;
  vapid: string | null;
  // Phones: the relay its boson.json names ('' none, undefined not looked
  // up yet).
  relay?: string;
  permission: PushPermission;
  // The user turned it off for this server.
  off: boolean;
  // Where registering got to.
  registration: 'idle' | 'pending' | 'ok' | 'failed';
  error?: string;
}

export type PushStatus =
  // Plain IRC (or via a bouncer): no row at all.
  | { state: 'hidden' }
  | { state: 'sign-in' }
  | { state: 'unavailable'; reason: string }
  | { state: 'off'; needsPermission?: boolean }
  | { state: 'pending' }
  | { state: 'on' };

export const DESKTOP_REASON = 'The desktop app notifies you while it’s running; push while it’s closed comes later.';
export const NO_WEBPUSH_REASON = 'This server doesn’t offer push notifications.';
export const NO_RELAY_REASON = 'This server doesn’t offer notifications on phones.';
export const DENIED_REASON = 'Notifications are blocked for Boson. Allow them in your system or browser settings.';

export function pushStatus(f: PushFacts): PushStatus {
  if (!f.boson || f.viaBouncer) return { state: 'hidden' };
  if (!f.signedIn) return { state: 'sign-in' };
  if (!f.platform) return { state: 'unavailable', reason: DESKTOP_REASON };
  if (f.unsupported) return { state: 'unavailable', reason: f.unsupported };
  if (f.cap === false || (f.cap === true && f.vapid === '')) return { state: 'unavailable', reason: NO_WEBPUSH_REASON };
  if ((f.platform === 'ios' || f.platform === 'android') && f.relay === '') return { state: 'unavailable', reason: NO_RELAY_REASON };
  if (f.permission === 'denied') return { state: 'unavailable', reason: DENIED_REASON };
  if (f.off) return { state: 'off' };
  if (f.permission === 'default') return { state: 'off', needsPermission: true };
  if (f.registration === 'failed') return { state: 'unavailable', reason: f.error || 'The server refused the subscription.' };
  if (f.registration === 'ok') return { state: 'on' };
  return { state: 'pending' };
}

// Whether the manager should register now: everything known and allowed.
export function shouldRegister(f: PushFacts): boolean {
  if (!f.boson || f.viaBouncer || !f.signedIn || !f.platform || f.unsupported) return false;
  if (f.cap !== true || !f.vapid) return false;
  if ((f.platform === 'ios' || f.platform === 'android') && !f.relay) return false;
  return f.permission === 'granted' && !f.off;
}
