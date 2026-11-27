// server-nick.ts — the nick the user picked on each server (/nick, or
// Server settings → Change nick), kept between runs so the next connect
// asks for it rather than the handle-derived default.
//
// Keyed by the person and the server (seenNamespace's shape: a Boson
// account's pick isn't another's on a shared device). Only what the user
// chose is kept: a fallback the server gave (nick_ while the old session
// held the nick, Guest123 from services) never is.

export const SERVER_NICK_KEY = 'boson:server-nick:v1';
// Servers remembered; the oldest entries go first.
const CAP = 500;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function read(s: Storage): Record<string, string> {
  try {
    const raw = s.getItem(SERVER_NICK_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** The key for a person (signed-in user id, or a guest) on a server. */
export function serverNickKey(serverId: string, userId?: string | null): string {
  return `${userId || 'guest'}::${serverId}`;
}

/** The nick picked for key, or undefined. */
export function loadServerNick(key: string, s: Storage | null = storage()): string | undefined {
  if (!s || !key) return undefined;
  return read(s)[key];
}

/** Remember (or, for "", forget) the nick picked for key. */
export function saveServerNick(key: string, nick: string, s: Storage | null = storage()): void {
  if (!s || !key) return;
  const all = read(s);
  const next = nick.trim();
  if (!next) {
    if (!(key in all)) return;
    delete all[key];
  } else {
    if (all[key] === next) return;
    delete all[key];
    all[key] = next;
  }
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - CAP))) delete all[k];
  try { s.setItem(SERVER_NICK_KEY, JSON.stringify(all)); } catch { /* full / blocked: the default next time */ }
}
