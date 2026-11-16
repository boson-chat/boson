// Local-only preferences about what Boson remembers of other people.
//
//   rememberHosts       — keep each nick's last user@host / account /
//                         realname after they leave (the "seen" store,
//                         modules/seen) and the host on join/part/quit lines.
//                         On by default, like IRCCloud. Nothing of it is ever
//                         sent anywhere.
//   showHostsInActivity — print the host after the nick on join/part/quit
//                         lines, "nick (~user@host) left". Off by default,
//                         as in HexChat; the host is a click / hover away
//                         either way.
//
// Persisted to localStorage; changes broadcast via a same-tab CustomEvent
// (mirrors embeds.store.ts).

import { signal } from '@preact/signals';

const STORAGE_KEY = 'boson:privacy:v1';

export interface PrivacySettings {
  rememberHosts: boolean;
  showHostsInActivity: boolean;
}

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  rememberHosts: true,
  showHostsInActivity: false,
};

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined') return null;
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

let cached: PrivacySettings | null = null;

export function getPrivacySettings(): PrivacySettings {
  if (cached) return cached;
  let next = { ...DEFAULT_PRIVACY_SETTINGS };
  const s = getStorage();
  if (s) {
    try {
      const raw = s.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<PrivacySettings>;
        next = {
          rememberHosts: typeof p.rememberHosts === 'boolean' ? p.rememberHosts : next.rememberHosts,
          showHostsInActivity: typeof p.showHostsInActivity === 'boolean' ? p.showHostsInActivity : next.showHostsInActivity,
        };
      }
    } catch { /* keep defaults */ }
  }
  cached = next;
  return next;
}

export function setPrivacySettings(patch: Partial<PrivacySettings>): void {
  const next = { ...getPrivacySettings(), ...patch };
  cached = next;
  const s = getStorage();
  if (s) { try { s.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ } }
  privacySettings.value = next;
  emitChange();
}

// The settings as a signal: a component reading `.value` re-renders when
// they change (the activity lines' "show hosts").
export const privacySettings = signal<PrivacySettings>(getPrivacySettings());

const EVENT_NAME = 'boson:privacy:change';
function emitChange(): void {
  const w = globalThis as { dispatchEvent?: (e: Event) => boolean };
  if (typeof CustomEvent === 'undefined' || !w.dispatchEvent) return;
  try { w.dispatchEvent(new CustomEvent(EVENT_NAME)); } catch { /* best-effort */ }
}
export function onPrivacySettingsChange(fn: () => void): () => void {
  const w = globalThis as {
    addEventListener?: (t: string, l: EventListener) => void;
    removeEventListener?: (t: string, l: EventListener) => void;
  };
  if (!w.addEventListener || !w.removeEventListener) return () => {};
  const l = (): void => fn();
  w.addEventListener(EVENT_NAME, l);
  return () => w.removeEventListener?.(EVENT_NAME, l);
}

// Test seam.
export function __resetPrivacySettingsCache(): void { cached = null; privacySettings.value = getPrivacySettings(); }
