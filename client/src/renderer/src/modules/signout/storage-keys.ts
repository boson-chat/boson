// What sign-out forgets from storage, and what it deliberately keeps.
//
// Every localStorage / secure-store key the app writes is listed here as
// either ACCOUNT (personal: wiped on sign-out) or DEVICE (a preference of
// this device that isn't about the person: kept). storage-keys.test.ts scans
// the renderer's source for key literals and fails on one in neither list,
// so a new store has to decide.
//
// Keys ending in ':' or '.' are prefixes (per user / per server / per
// network keys).

import type { SecureStorage } from '../../shared/secure-storage';
import type { SignOutContext } from './sign-out';

export interface KeySet {
  local: readonly string[];
  secure: readonly string[];
}

export const ACCOUNT_KEYS: KeySet = {
  local: [
    'boson:session:v1', // saved servers + channels (legacy)
    'boson:session:v2', // saved servers + channels, bouncer routes
    'boson:local-servers:v1', // servers added by hand
    'boson:directories:v1', // directories added in Settings
    'boson:autojoin-done:v1', // networks already auto-joined
    'boson:home-joined:v1', // a self-hosted web client's own IRC server, added once
    'boson:guest:v1', // guest mode nick
    'boson:notifications:channels:v1', // per-channel / DM notification levels
    'boson:notifications:servers:v1', // per-server notification levels
    'boson:prefs-sync:v1', // when the synced preferences last changed here
    'boson.netauth.known', // network accounts (self-hosted auth services)
    'boson.netauth.guest', // networks the user chose to use as a guest
    'boson.login.lastServer', // "sign in to another server" last used
    'boson.memos.', // memos / DM inbox, per user
    'boson:notify-feed:v1:', // friend + call notifications, per user
    'boson.voice.guestId:', // guest voice id, per auth service
    'boson.services-creds.', // legacy plain-text NickServ passwords, per server
    'boson:recovery-pending:', // recovery code not yet confirmed at sign-up, per user
    'boson:read-markers:v1:', // how far each conversation was read, per user + server
    'boson:server-nick:v1', // the nick picked on each server, per user + server
    'boson:image-dims:v1', // sizes of images seen in conversations (by URL)
    'boson:push:v1', // push subscriptions per server (endpoints, turned off)
  ],
  secure: [
    'boson.auth.session', // the access + refresh token
    'boson.identity.', // the identity secret, per user
    'boson.netauth.session:', // network account sessions, per auth service
    'boson.services-creds.v1', // NickServ / SASL passwords
    'boson.bouncer.v1', // the bouncer (ZNC) profile, with its password
    'boson.nickserv-sync.meta', // credential sync bookkeeping
    'boson.bouncer-sync.meta',
  ],
};

// Kept on sign-out: how this device looks and sounds, not who used it.
export const DEVICE_KEYS: KeySet = {
  local: [
    'boson:theme:v1', // the chosen theme
    'boson:themes:custom:v1', // themes made on this device
    'boson:network-themes:v1', // cache of networks' public theme documents
    'boson:network-themes:off:v1', // networks whose theme is turned off
    'boson:network-themes:enabled', // network themes on/off
    'boson:panel-sizes:v1', // window layout (panel widths)
    'boson:voice:v1', // audio devices, push-to-talk, VAD, quality
    'boson.screenShare', // last screen-share source + mode
    'boson:notifications:v1', // notification preferences (sounds, banners)
    'boson:privacy:v1', // remember hosts / show hosts
    'boson:embeds:v1', // link preview preferences
    'boson:chat-display:v1', // how conversations read (guessed replies)
    'boson:voice-servers:v1', // cache of networks' public boson.json (web)
    'boson:services-verdict:v1', // which services package each network runs
    'boson:guest:last-nick:v1', // the guest-first nick, so a returning visitor keeps it
  ],
  secure: [],
};

// Literals that look like keys but aren't storage keys (event names, hosts).
export const NOT_KEYS: readonly string[] = [
  'boson:embeds:change', 'boson:chat-display:change', 'boson:guest:change', 'boson:notifications:change', 'boson:privacy:change',
  'boson:network', 'boson.chat', 'boson.ircforever.org', 'boson.json', 'boson.json:', 'boson:push-open',
  'boson:', // the boson:// URL scheme
  'boson.', // the secure stores' minimum prefix
];

const isPrefix = (k: string): boolean => k.endsWith(':') || k.endsWith('.');

export function matches(key: string, list: readonly string[]): boolean {
  return list.some((k) => (isPrefix(k) ? key.startsWith(k) : key === k));
}

type Local = Pick<Storage, 'removeItem'> & { readonly length: number; key(i: number): string | null };

function defaultLocal(): Local | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

// Removes every ACCOUNT key from localStorage and the secure store. Without
// a prefix removal in the secure store (an older shell), removes the keys it
// can name: the user's identity and the known networks' sessions.
export async function wipeAccountStorage(
  ctx: SignOutContext,
  secure: SecureStorage,
  local: Local | null = defaultLocal(),
  knownAuthUrls: readonly string[] = [],
): Promise<void> {
  const errors: unknown[] = [];
  for (const k of ACCOUNT_KEYS.secure) {
    try {
      if (!isPrefix(k)) await secure.remove(k);
      else if (secure.removePrefix) await secure.removePrefix(k);
      else throw new Error('no removePrefix');
    } catch (err) {
      if (!isPrefix(k)) { errors.push(err); continue; }
      // Fallback: the names we know.
      const named = k === 'boson.identity.'
        ? (ctx.userId ? [`${k}${ctx.userId}`] : [])
        : knownAuthUrls.map((u) => `${k}${u}`);
      for (const n of named) {
        try { await secure.remove(n); } catch (e) { errors.push(e); }
      }
    }
  }
  if (local) {
    const doomed: string[] = [];
    for (let i = 0; i < local.length; i++) {
      const k = local.key(i);
      if (k && matches(k, ACCOUNT_KEYS.local)) doomed.push(k);
    }
    for (const k of doomed) {
      try { local.removeItem(k); } catch (err) { errors.push(err); }
    }
  }
  if (errors.length) throw new Error(`wipeAccountStorage: ${errors.length} key(s) not removed`);
}
