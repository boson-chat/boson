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
export function __resetNotificationSettingsCache(): void { cached = null; levels = null; servers = null; }

// How an incoming call shows on this device: the setting, else full screen
// on phones (and narrow windows) and a banner on desktop.
export function incomingCallStyle(phone: boolean, s: NotificationSettings = getNotificationSettings()): IncomingCallStyle {
  return s.incomingCalls ?? (phone ? 'full' : 'banner');
}

// ---- Per server, then per channel: All / Mentions / Nothing ----
// A server sets what its channels and its DMs notify about (Server
// settings → Notifications; by default channels Mentions, DMs All). A
// channel or DM can have its own (Channel settings, or its context menu),
// over the server's; "Server default" takes it back off.

export type ChannelLevel = 'all' | 'mentions' | 'nothing';
export type DmLevel = 'all' | 'nothing';
export interface ServerNotifyLevels {
  // What a channel on this server notifies about, unless it has its own.
  channels: ChannelLevel;
  // What a DM on this server notifies about, unless it has its own.
  dms: DmLevel;
}
// In words (menus, settings rows).
export const LEVEL_LABEL: Record<ChannelLevel, string> = { all: 'All messages', mentions: 'Mentions only', nothing: 'Nothing' };
export const DEFAULT_SERVER_LEVELS: ServerNotifyLevels = { channels: 'mentions', dms: 'all' };

const LEVELS_KEY = 'boson:notifications:channels:v1';
const SERVERS_KEY = 'boson:notifications:servers:v1';
let levels: Record<string, ChannelLevel> | null = null;
let servers: Record<string, Partial<ServerNotifyLevels>> | null = null;

const isLevel = (v: unknown): v is ChannelLevel => v === 'all' || v === 'mentions' || v === 'nothing';
const isChannelName = (name: string): boolean => /^[#&]/.test(name);

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
      for (const [k, v] of Object.entries(p)) if (isLevel(v)) levels[k] = v;
    }
  } catch { /* defaults */ }
  return levels;
}

function loadServers(): Record<string, Partial<ServerNotifyLevels>> {
  if (servers) return servers;
  servers = {};
  const s = getStorage();
  try {
    const raw = s?.getItem(SERVERS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, { channels?: unknown; dms?: unknown }>;
      for (const [id, v] of Object.entries(p)) {
        const e: Partial<ServerNotifyLevels> = {};
        if (isLevel(v?.channels)) e.channels = v.channels;
        if (v?.dms === 'all' || v?.dms === 'nothing') e.dms = v.dms;
        servers[id] = e;
      }
    }
  } catch { /* defaults */ }
  return servers;
}

// Sign-out: forget the levels held in memory (the storage wipe removes the
// saved copies). The global preferences are this device's and stay.
export function clearChannelLevelsForSignOut(): void {
  levels = null;
  servers = null;
}

// With nothing set for the server either.
export function defaultChannelLevel(channel: string): ChannelLevel {
  return isChannelName(channel) ? DEFAULT_SERVER_LEVELS.channels : DEFAULT_SERVER_LEVELS.dms;
}

export function getServerLevels(serverId: string): ServerNotifyLevels {
  return { ...DEFAULT_SERVER_LEVELS, ...loadServers()[serverId] };
}

export function setServerLevels(serverId: string, patch: Partial<ServerNotifyLevels>): void {
  const merged = { ...getServerLevels(serverId), ...patch };
  const entry: Partial<ServerNotifyLevels> = {};
  if (merged.channels !== DEFAULT_SERVER_LEVELS.channels) entry.channels = merged.channels;
  if (merged.dms !== DEFAULT_SERVER_LEVELS.dms) entry.dms = merged.dms;
  const next = { ...loadServers() };
  if (Object.keys(entry).length) next[serverId] = entry;
  else delete next[serverId];
  servers = next;
  const s = getStorage();
  if (s) { try { s.setItem(SERVERS_KEY, JSON.stringify(next)); } catch { /* best-effort */ } }
  emitChange();
}

// What the server gives a conversation that has no level of its own.
export function serverDefaultLevel(serverId: string, channel: string): ChannelLevel {
  const sv = getServerLevels(serverId);
  return isChannelName(channel) ? sv.channels : sv.dms;
}

// The conversation's own level, if it has one.
export function getOwnChannelLevel(serverId: string, channel: string): ChannelLevel | undefined {
  return loadLevels()[levelKey(serverId, channel)];
}

// The level in effect: its own, else the server's.
export function getChannelLevel(serverId: string, channel: string): ChannelLevel {
  return getOwnChannelLevel(serverId, channel) ?? serverDefaultLevel(serverId, channel);
}

// Give a conversation its own level, or ('default') follow the server's.
export function setChannelLevel(serverId: string, channel: string, level: ChannelLevel | 'default'): void {
  const next = { ...loadLevels() };
  if (level === 'default') delete next[levelKey(serverId, channel)];
  else next[levelKey(serverId, channel)] = level;
  levels = next;
  const s = getStorage();
  if (s) { try { s.setItem(LEVELS_KEY, JSON.stringify(next)); } catch { /* best-effort */ } }
  emitChange();
}

// The conversations on a server with a level of their own (names as saved:
// lower case), channels first.
export function ownChannelLevels(serverId: string): Array<{ channel: string; level: ChannelLevel }> {
  const prefix = `${serverId}\0`;
  return Object.entries(loadLevels())
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, level]) => ({ channel: k.slice(prefix.length), level }))
    .sort((a, b) => Number(isChannelName(b.channel)) - Number(isChannelName(a.channel)) || a.channel.localeCompare(b.channel));
}

// Every level set (servers' and conversations'), for receivers that apply
// them away from this page (push: modules/push/filter.ts). Conversation keys
// are `${serverId}\0${name lower-cased}`.
export function notificationLevelsSnapshot(): {
  servers: Record<string, Partial<ServerNotifyLevels>>;
  levels: Record<string, ChannelLevel>;
} {
  return { servers: { ...loadServers() }, levels: { ...loadLevels() } };
}
