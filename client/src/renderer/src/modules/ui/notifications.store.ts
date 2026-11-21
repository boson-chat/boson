// Local-only notification preferences (this device). Persisted to
// localStorage; changes broadcast via a same-tab CustomEvent so the settings
// UI + notifier react live. Defaults: in-app toasts and system notifications
// on, for mentions, DMs, friends and calls (not every message). Incoming
// calls show full screen on phones and as a banner on desktop.

const STORAGE_KEY = 'boson:notifications:v1';

export type IncomingCallStyle = 'full' | 'banner';

export interface NotificationSettings {
  // System notifications (OS banners while Boson is in the background).
  enabled: boolean;
  // In-app toasts (desktop: cards top right; phones: a banner from the top).
  inApp: boolean;
  // Notify when another user says your nick in a channel.
  mentions: boolean;
  // Notify on any direct (1:1) message.
  directMessages: boolean;
  // Notify on every channel message (noisy; off by default).
  allMessages: boolean;
  // Friend requests and accepts.
  friends: boolean;
  // Missed calls, and calls starting in voice channels you're in.
  calls: boolean;
  // A sound with each one (the OS's for system notifications).
  sound: boolean;
  // How an incoming call shows; absent: this device's default.
  incomingCalls?: IncomingCallStyle;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  mentions: true,
  directMessages: true,
  allMessages: false,
  inApp: true,
  friends: true,
  calls: true,
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
          inApp: typeof p.inApp === 'boolean' ? p.inApp : next.inApp,
          friends: typeof p.friends === 'boolean' ? p.friends : next.friends,
          calls: typeof p.calls === 'boolean' ? p.calls : next.calls,
          ...(p.incomingCalls === 'full' || p.incomingCalls === 'banner' ? { incomingCalls: p.incomingCalls } : {}),
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
export function __resetNotificationSettingsCache(): void { cached = null; levels = null; }

// How an incoming call shows on this device: the setting, else full screen
// on phones (and narrow windows) and a banner on desktop.
export function incomingCallStyle(phone: boolean, s: NotificationSettings = getNotificationSettings()): IncomingCallStyle {
  return s.incomingCalls ?? (phone ? 'full' : 'banner');
}

// ---- Per-channel: All / Mentions / Nothing ----
// From a channel's (or DM's) context menu. Channels default to Mentions
// (mentions only), DMs to All.

export type ChannelLevel = 'all' | 'mentions' | 'nothing';
const LEVELS_KEY = 'boson:notifications:channels:v1';
let levels: Record<string, ChannelLevel> | null = null;

function levelKey(serverId: string, channel: string): string {
  return `${serverId}\0${channel.toLowerCase()}`;
}

function loadLevels(): Record<string, ChannelLevel> {
  if (levels) return levels;
  levels = {};
  const s = getStorage();
  try {
    const raw = s?.getItem(LEVELS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(p)) if (v === 'all' || v === 'mentions' || v === 'nothing') levels[k] = v;
    }
  } catch { /* defaults */ }
  return levels;
}

// Sign-out: forget the per-channel levels held in memory (the storage wipe
// removes the saved copy). The global preferences are this device's and stay.
export function clearChannelLevelsForSignOut(): void {
  levels = null;
}

export function defaultChannelLevel(channel: string): ChannelLevel {
  return /^[#&]/.test(channel) ? 'mentions' : 'all';
}

export function getChannelLevel(serverId: string, channel: string): ChannelLevel {
  return loadLevels()[levelKey(serverId, channel)] ?? defaultChannelLevel(channel);
}

export function setChannelLevel(serverId: string, channel: string, level: ChannelLevel): void {
  const next = { ...loadLevels() };
  if (level === defaultChannelLevel(channel)) delete next[levelKey(serverId, channel)];
  else next[levelKey(serverId, channel)] = level;
  levels = next;
  const s = getStorage();
  if (s) { try { s.setItem(LEVELS_KEY, JSON.stringify(next)); } catch { /* best-effort */ } }
  emitChange();
}
