// A directory listing's default channels (`autojoin_channels`, e.g. #lobby):
// the channels a network puts new people in. The network's own services do
// that server-side (RoleServ SAJOIN), so on any client a newcomer lands in
// them; this is the client's fallback for networks that don't (yet): on the
// FIRST connect to a network from its directory card, a few seconds after
// registration, join the ones we aren't in. Never again after that — leaving
// #lobby sticks.
//
// "First" is per network (hostname:port), remembered in localStorage.

// How long after registration to wait: the server's own auto-join usually
// lands first, and then there's nothing left to do.
export const AUTOJOIN_DELAY_MS = 3000;
// A listing can't make us join more than this many channels.
export const MAX_AUTOJOIN = 10;

const STORAGE_KEY = 'boson:autojoin-done:v1';
// Bounded: the oldest networks drop off (they'd at worst get one more
// auto-join on a connect after a very long time).
const MAX_REMEMBERED = 500;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): Store | null {
  try {
    return (globalThis as { localStorage?: Store }).localStorage ?? null;
  } catch {
    return null;
  }
}

// IRC channel names as a directory may list them: #, then printable ASCII
// without space or comma (the directory checks the same).
const CHANNEL_RE = /^#[\x21-\x2b\x2d-\x7e]{1,63}$/;

export function validAutojoinChannels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of v) {
    if (typeof c !== 'string' || !CHANNEL_RE.test(c)) continue;
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export function networkKey(server: { hostname: string; port: number }): string {
  return `${server.hostname.trim().toLowerCase()}:${server.port}`;
}

function load(s: Store): string[] {
  try {
    const v = JSON.parse(s.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Whether this network's default channels were already taken care of.
export function autojoinDone(server: { hostname: string; port: number }, s: Store | null = storage()): boolean {
  if (!s) return true; // nowhere to remember it: don't risk joining every time
  return load(s).includes(networkKey(server));
}

export function markAutojoinDone(server: { hostname: string; port: number }, s: Store | null = storage()): void {
  if (!s) return;
  const key = networkKey(server);
  const list = load(s).filter((k) => k !== key);
  list.push(key);
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(list.slice(-MAX_REMEMBERED)));
  } catch {
    // Full or blocked storage: it'll just be tried once more next time.
  }
}

// The default channels still to join: those we aren't in (or joining)
// already, case-insensitively.
export function channelsToAutojoin(wanted: readonly string[], have: Iterable<string>): string[] {
  const in_ = new Set<string>();
  for (const c of have) in_.add(c.toLowerCase());
  return validAutojoinChannels(wanted).filter((c) => !in_.has(c.toLowerCase())).slice(0, MAX_AUTOJOIN);
}

// "Joins #lobby" / "Joins #lobby, #help" / "Joins #a, #b +2" for the card.
export function joinsLabel(channels: readonly string[] | undefined, shown = 2): string | null {
  const list = validAutojoinChannels(channels ?? []);
  if (list.length === 0) return null;
  const head = list.slice(0, shown).join(', ');
  return list.length > shown ? `Joins ${head} +${list.length - shown}` : `Joins ${head}`;
}
