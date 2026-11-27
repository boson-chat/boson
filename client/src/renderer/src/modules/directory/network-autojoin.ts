// A network's own auto-join channels (its auth service's GET /v1/config
// `channels` with `autojoin: true`): on Ergo installs RoleServ joins
// accounts and guests to them; on networks without it (an IRC network
// behind the evrd bridge, like ircforever's ngIRCd) nobody would, so the
// app joins them itself, a few seconds after registration (RoleServ's
// SAJOIN, where there is one, lands first; a duplicate JOIN does nothing).
//
// Once per channel, per account (or guest nick) and server: what was
// handled is remembered on the device and, for accounts, in the synced
// session (SavedServerSession.networkAutojoined), so leaving a channel
// sticks, and a channel added to the config later is joined once.
// Channels only some roles may join are never joined this way.
import type { AuthConfig } from '../auth/auth.service';
import { MAX_AUTOJOIN, networkKey, validAutojoinChannels } from './autojoin';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try { return (globalThis as { localStorage?: Store }).localStorage ?? null; } catch { return null; }
}

const STORAGE_KEY = 'boson:net-autojoin:v1';
const MAX_REMEMBERED = 200;

// The channels to join on this network: auto-join, open to everyone; none
// for a guest when the network doesn't join guests (autojoin_guests: false).
export function networkAutojoinChannels(
  cfg: Pick<AuthConfig, 'channels' | 'autojoin_guests'> | null | undefined,
  opts: { guest: boolean },
): string[] {
  if (!cfg?.channels?.length) return [];
  if (opts.guest && cfg.autojoin_guests === false) return [];
  const names = cfg.channels.filter((c) => c.autojoin && !c.restricted && !c.roles?.length).map((c) => c.name);
  return validAutojoinChannels(names).slice(0, MAX_AUTOJOIN);
}

// Who the record is for: an account (its id) or a guest nick.
export function autojoinWho(o: { userId?: string | null; guestNick?: string | null }): string {
  return o.userId ? `user:${o.userId}` : `guest:${(o.guestNick ?? '').toLowerCase()}`;
}

type Record_ = Record<string, string[]>;

function load(s: Store): Record_ {
  try {
    const v = JSON.parse(s.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record_) : {};
  } catch {
    return {};
  }
}

const entryKey = (server: { hostname: string; port: number }, who: string): string => `${networkKey(server)}|${who}`;

// The channels already handled here (lowercased).
export function networkAutojoined(server: { hostname: string; port: number }, who: string, s: Store | null = storage()): string[] {
  if (!s) return [];
  const v = load(s)[entryKey(server, who)];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function markNetworkAutojoined(server: { hostname: string; port: number }, who: string, channels: readonly string[], s: Store | null = storage()): void {
  if (!s || channels.length === 0) return;
  const all = load(s);
  const key = entryKey(server, who);
  const set = new Set([...(all[key] ?? []), ...channels.map((c) => c.toLowerCase())]);
  delete all[key];
  all[key] = [...set];
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete all[k];
  try { s.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* storage full or off: tried again next time */ }
}

// Of `wanted`, the ones to join now: not handled before, not in already.
export function networkChannelsToJoin(wanted: readonly string[], done: Iterable<string>, have: Iterable<string>): string[] {
  const skip = new Set<string>();
  for (const c of done) skip.add(c.toLowerCase());
  for (const c of have) skip.add(c.toLowerCase());
  return wanted.filter((c) => !skip.has(c.toLowerCase()));
}
