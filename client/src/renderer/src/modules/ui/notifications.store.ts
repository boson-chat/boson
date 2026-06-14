// Local-only preferences for desktop notifications. Persisted to localStorage;
// changes broadcast via a same-tab CustomEvent so the settings UI + notifier
// react live. Defaults: on, for mentions + direct messages (not every message).

const STORAGE_KEY = 'boson:notifications:v1';

export interface NotificationSettings {
  // Master switch.
  enabled: boolean;
  // Notify when another user says your nick in a channel.
  mentions: boolean;
  // Notify on any direct (1:1) message.
  directMessages: boolean;
  // Notify on every channel message (noisy; off by default).
  allMessages: boolean;
  // Play the OS notification sound (vs a silent banner).
  sound: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  mentions: true,
  directMessages: true,
  allMessages: false,
  sound: true,
};

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined') return null;
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

let cached: NotificationSettings | null = null;

export function getNotificationSettings(): NotificationSettings {
  if (cached) return cached;
  let next = { ...DEFAULT_NOTIFICATION_SETTINGS };
  const s = getStorage();
  if (s) {
    try {
      const raw = s.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<NotificationSettings>;
        next = {
          enabled: typeof p.enabled === 'boolean' ? p.enabled : next.enabled,
          mentions: typeof p.mentions === 'boolean' ? p.mentions : next.mentions,
          directMessages: typeof p.directMessages === 'boolean' ? p.directMessages : next.directMessages,
          allMessages: typeof p.allMessages === 'boolean' ? p.allMessages : next.allMessages,
          sound: typeof p.sound === 'boolean' ? p.sound : next.sound,
        };
      }
    } catch { /* keep defaults */ }
  }
  cached = next;
  return next;
}

export function setNotificationSettings(patch: Partial<NotificationSettings>): void {
  const next = { ...getNotificationSettings(), ...patch };
  cached = next;
  const s = getStorage();
  if (s) { try { s.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ } }
  emitChange();
}

const EVENT_NAME = 'boson:notifications:change';
function emitChange(): void {
  const w = globalThis as { dispatchEvent?: (e: Event) => boolean };
  if (typeof CustomEvent === 'undefined' || !w.dispatchEvent) return;
  try { w.dispatchEvent(new CustomEvent(EVENT_NAME)); } catch { /* best-effort */ }
}
export function onNotificationSettingsChange(fn: () => void): () => void {
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
export function __resetNotificationSettingsCache(): void { cached = null; }
