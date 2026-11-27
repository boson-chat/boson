// Whether a decrypted push is shown (docs/push.md §3.3): the app's
// notification settings and the per-server / per-channel levels, applied on
// the device after decryption — the server pushes every DM and highlight.
// The renderer hands receivers a snapshot of the settings (PushPrefs);
// receivers that can't run this code (the iOS extension, the Android
// service) apply the same rules to the same JSON.
import type { PushMessage } from './payload';

export type Level = 'all' | 'mentions' | 'nothing';

export interface PushPrefs {
  v: 1;
  // System notifications at all (Settings → Notifications).
  enabled: boolean;
  mentions: boolean;
  directMessages: boolean;
  // Per server: what its channels and DMs notify about.
  servers: Record<string, { channels?: Level; dms?: 'all' | 'nothing' }>;
  // Per conversation, keyed `${serverId}\0${conversation lower-cased}`.
  levels: Record<string, Level>;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  v: 1, enabled: true, mentions: true, directMessages: true, servers: {}, levels: {},
};

function levelFor(p: PushPrefs, serverId: string, conversation: string, dm: boolean): Level {
  const own = p.levels[`${serverId}\0${conversation.toLowerCase()}`];
  if (own) return own;
  const sv = p.servers[serverId];
  if (dm) return sv?.dms ?? 'all';
  return sv?.channels ?? 'mentions';
}

export function shouldShowPush(m: PushMessage, serverId: string, prefs: PushPrefs | null | undefined): boolean {
  if (m.type !== 'message') return false;
  const p = prefs ?? DEFAULT_PUSH_PREFS;
  if (!p.enabled) return false;
  const level = levelFor(p, serverId, m.conversation, m.kind === 'dm');
  if (level === 'nothing') return false;
  return m.kind === 'dm' ? p.directMessages : p.mentions;
}

// A snapshot read back from storage (another version may have written it).
export function cleanPrefs(raw: unknown): PushPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PushPrefs>;
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const isLevel = (v: unknown): v is Level => v === 'all' || v === 'mentions' || v === 'nothing';
  const servers: PushPrefs['servers'] = {};
  for (const [id, v] of Object.entries(r.servers && typeof r.servers === 'object' ? r.servers : {})) {
    const e: PushPrefs['servers'][string] = {};
    if (isLevel(v?.channels)) e.channels = v.channels;
    if (v?.dms === 'all' || v?.dms === 'nothing') e.dms = v.dms;
    servers[id] = e;
  }
  const levels: PushPrefs['levels'] = {};
  for (const [k, v] of Object.entries(r.levels && typeof r.levels === 'object' ? r.levels : {})) {
    if (isLevel(v)) levels[k] = v;
  }
  return {
    v: 1,
    enabled: bool(r.enabled, true),
    mentions: bool(r.mentions, true),
    directMessages: bool(r.directMessages, true),
    servers,
    levels,
  };
}
