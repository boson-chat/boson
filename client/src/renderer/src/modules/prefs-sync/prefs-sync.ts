// Preferences that follow the account across devices: notifications (the
// switches, and the levels per server and per conversation), link previews
// and privacy. They travel inside the synced session blob (PUT /me/session,
// which the backend stores verbatim) under `prefs`, last write wins by
// `updatedAt`.
//
// What stays on each device: audio devices and voice settings, window
// layout, themes (custom ones can be files on one machine), caches.
//
// The stores keep their own localStorage keys; this module copies those
// values in and out, reloads the stores after applying a synced copy, and
// notices local changes through each store's change event.

import {
  __resetNotificationSettingsCache, onNotificationSettingsChange,
} from '../ui/notifications.store';
import { __resetEmbedSettingsCache, onEmbedSettingsChange } from '../ui/embeds.store';
import { __resetPrivacySettingsCache, onPrivacySettingsChange } from '../ui/privacy.store';

export const SYNCED_PREF_KEYS = [
  'boson:notifications:v1',
  'boson:notifications:channels:v1',
  'boson:notifications:servers:v1',
  'boson:embeds:v1',
  'boson:privacy:v1',
] as const;

// When this device last changed one of them (or took the synced copy).
const META_KEY = 'boson:prefs-sync:v1';

export interface SyncedPrefs {
  updatedAt: number;
  // Each store's saved JSON, as stored.
  values: Record<string, string>;
}

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function storage(): KV | null {
  try { return (globalThis as { localStorage?: KV }).localStorage ?? null; } catch { return null; }
}

export function localPrefsUpdatedAt(): number {
  try {
    const raw = storage()?.getItem(META_KEY);
    const n = raw ? Number(JSON.parse(raw)?.updatedAt) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function setLocalUpdatedAt(t: number): void {
  try { storage()?.setItem(META_KEY, JSON.stringify({ updatedAt: t })); } catch { /* best-effort */ }
}

// This device's preferences, for the synced blob.
export function collectPrefs(): SyncedPrefs {
  const s = storage();
  const values: Record<string, string> = {};
  for (const k of SYNCED_PREF_KEYS) {
    try {
      const v = s?.getItem(k);
      if (v != null) values[k] = v;
    } catch { /* skip */ }
  }
  return { updatedAt: localPrefsUpdatedAt(), values };
}

export function isSyncedPrefs(v: unknown): v is SyncedPrefs {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.updatedAt !== 'number' || !o.values || typeof o.values !== 'object') return false;
  return Object.values(o.values as Record<string, unknown>).every((x) => typeof x === 'string');
}

let applying = false;

// Take the synced copy: write its values (a key it doesn't have goes back
// to the default) and reload the stores, which tell their screens.
export function applyPrefs(p: SyncedPrefs): void {
  const s = storage();
  if (!s) return;
  applying = true;
  try {
    for (const k of SYNCED_PREF_KEYS) {
      const v = p.values[k];
      try {
        if (typeof v === 'string') s.setItem(k, v);
        else s.removeItem(k);
      } catch { /* best-effort */ }
    }
    setLocalUpdatedAt(p.updatedAt);
    __resetNotificationSettingsCache();
    __resetEmbedSettingsCache();
    __resetPrivacySettingsCache();
    // Each store's change event: settings screens and the notifier re-read.
    for (const name of ['boson:notifications:change', 'boson:embeds:change', 'boson:privacy:change']) {
      try { (globalThis as { dispatchEvent?: (e: Event) => boolean }).dispatchEvent?.(new CustomEvent(name)); } catch { /* best-effort */ }
    }
  } finally {
    applying = false;
  }
}

// What to do with the synced copy at sign-in: take it when it's newer than
// this device's, else push this device's up (it changed since).
export function reconcilePrefs(remote: unknown): 'applied' | 'push' | 'same' {
  const local = localPrefsUpdatedAt();
  if (isSyncedPrefs(remote) && remote.updatedAt > local) {
    applyPrefs(remote);
    return 'applied';
  }
  if (!isSyncedPrefs(remote)) {
    // Nothing synced yet: this device's set (if it has one) starts it,
    // stamped now so the others take it.
    if (Object.keys(collectPrefs().values).length === 0) return 'same';
    if (local === 0) setLocalUpdatedAt(Date.now());
    return 'push';
  }
  return remote.updatedAt < local ? 'push' : 'same';
}

// A local change to any of them (not our own applying of a synced copy):
// stamp it and call `fn` (the caller pushes, debounced).
export function onLocalPrefsChange(fn: () => void): () => void {
  const changed = (): void => {
    if (applying) return;
    setLocalUpdatedAt(Date.now());
    fn();
  };
  const offs = [onNotificationSettingsChange(changed), onEmbedSettingsChange(changed), onPrivacySettingsChange(changed)];
  return () => { for (const off of offs) off(); };
}
