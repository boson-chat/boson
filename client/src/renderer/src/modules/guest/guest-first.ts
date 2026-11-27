// Guest-first entry: a self-hosted network whose auth service says
// guest_first (GET /v1/config) opens its web client straight into chat as a
// guest — a ready, friendly nick ("ZestyKiwi"), one "Join chat" button,
// sign-in and sign-up a click away — like the evrd web-chat embed it
// replaces (ircforever.org/chat/). Joining lands on guest_first_channel
// after the network's auto-join channels.
//
// Links can steer it: ?nick= fills the nick, ?channel= (or #channel) picks
// the channel to land on when guests may join it, ?join=1 joins without the
// click (for embedding and links from the network's site).
import { guestAccessAllowed, type AuthConfig } from '../auth/auth.service';
import { sanitizeIrcNick } from '../identity/nick';

// ---- friendly nicks ----

const ADJECTIVES = [
  'Amber', 'Bold', 'Brave', 'Breezy', 'Bright', 'Calm', 'Clever', 'Cosmic', 'Cozy', 'Crisp',
  'Daring', 'Dapper', 'Dusky', 'Eager', 'Fancy', 'Fizzy', 'Fluffy', 'Gentle', 'Giddy', 'Glowy',
  'Happy', 'Hazy', 'Jolly', 'Jumpy', 'Keen', 'Lucky', 'Lunar', 'Mellow', 'Merry', 'Misty',
  'Nimble', 'Noble', 'Peppy', 'Plucky', 'Quick', 'Quiet', 'Rapid', 'Rosy', 'Rusty', 'Salty',
  'Shiny', 'Snappy', 'Solar', 'Sparky', 'Spicy', 'Sunny', 'Swift', 'Tidy', 'Witty', 'Zesty',
];

const ANIMALS = [
  'Badger', 'Bat', 'Bear', 'Beaver', 'Bison', 'Crane', 'Crow', 'Deer', 'Dingo', 'Duck',
  'Eagle', 'Eel', 'Falcon', 'Ferret', 'Finch', 'Fox', 'Frog', 'Gecko', 'Goat', 'Gull',
  'Hare', 'Hawk', 'Heron', 'Ibis', 'Koala', 'Kiwi', 'Lemur', 'Lion', 'Llama', 'Lynx',
  'Mole', 'Moose', 'Newt', 'Otter', 'Owl', 'Panda', 'Puffin', 'Quail', 'Raven', 'Robin',
  'Seal', 'Shrew', 'Sloth', 'Squid', 'Stoat', 'Swan', 'Tapir', 'Tiger', 'Toad', 'Wombat',
];

// An IRC-valid nick like "ZestyKiwi": an adjective and an animal, capped at
// 16 characters (the safe nick length). From the second try on, two digits
// are added ("ZestyKiwi42"), so a busy network still finds a free one.
export function friendlyNick(random: () => number = Math.random, attempt = 0): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length) % list.length]!;
  const base = `${pick(ADJECTIVES)}${pick(ANIMALS)}`;
  const suffix = attempt > 0 ? String(10 + Math.floor(random() * 90)) : '';
  return sanitizeIrcNick(base.slice(0, 16 - suffix.length) + suffix);
}

// ---- the nick kept on this device ----

const LAST_NICK_KEY = 'boson:guest:last-nick:v1';

interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function local(): Store | null {
  try { return (globalThis as { localStorage?: Store }).localStorage ?? null; } catch { return null; }
}

export interface RememberedNick {
  nick: string;
  // Made for the visitor (not typed): renamed to a fresh one on a collision.
  auto: boolean;
}

// The guest nick last used on this device: returning visitors keep it,
// also after leaving guest mode (signing out clears the guest session).
export function lastGuestNick(store: Store | null = local()): RememberedNick | null {
  try {
    const v = JSON.parse(store?.getItem(LAST_NICK_KEY) ?? 'null') as unknown;
    if (!v || typeof v !== 'object') return null;
    const { nick, auto } = v as { nick?: unknown; auto?: unknown };
    if (typeof nick !== 'string' || !nick) return null;
    return { nick, auto: auto === true };
  } catch {
    return null;
  }
}

export function rememberGuestNick(nick: string, auto: boolean, store: Store | null = local()): void {
  try { store?.setItem(LAST_NICK_KEY, JSON.stringify({ nick, auto })); } catch { /* storage off */ }
}

// Whether the guest's current nick is one made for them (so a collision
// picks a fresh friendly one rather than "ZestyKiwi_").
export function guestNickIsAuto(nick: string, store: Store | null = local()): boolean {
  const last = lastGuestNick(store);
  return !!last?.auto && last.nick.toLowerCase() === nick.toLowerCase();
}

// ---- the network's settings ----

// The home network opens its web client straight into chat as a guest.
export function guestFirstOn(cfg: Pick<AuthConfig, 'guest_first' | 'guest_access'> | null | undefined): boolean {
  return cfg?.guest_first === true && guestAccessAllowed(cfg);
}

const CHANNEL_RE = /^[#&][\x21-\x2b\x2d-\x7e]{1,63}$/;

export function validChannel(s: string | null | undefined): s is string {
  return !!s && CHANNEL_RE.test(s);
}

function restricted(cfg: Pick<AuthConfig, 'channels'> | null | undefined, channel: string): boolean {
  const k = channel.toLowerCase();
  return !!cfg?.channels?.some((c) => c.name.toLowerCase() === k && c.restricted);
}

// The network's auto-join channels guests may join (guests are joined to
// them on connect; the client joins what the server didn't).
export function guestAutojoinChannels(cfg: Pick<AuthConfig, 'channels'> | null | undefined): string[] {
  return (cfg?.channels ?? []).filter((c) => c.autojoin && !c.restricted && validChannel(c.name)).map((c) => c.name);
}

// Where a guest lands: the link's channel when guests may join it, else the
// network's guest_first_channel, else its first auto-join channel. null:
// nowhere in particular.
export function landingChannel(
  cfg: Pick<AuthConfig, 'channels' | 'guest_first_channel'> | null | undefined,
  requested?: string | null,
): string | null {
  if (validChannel(requested) && !restricted(cfg, requested)) return requested;
  if (validChannel(cfg?.guest_first_channel) && !restricted(cfg, cfg.guest_first_channel)) return cfg.guest_first_channel;
  return guestAutojoinChannels(cfg)[0] ?? null;
}

// ---- links ----

export interface GuestFirstLink {
  nick: string | null;
  channel: string | null;
  join: boolean;
}

const NO_LINK: GuestFirstLink = Object.freeze({ nick: null, channel: null, join: false });

function cleanNick(raw: string | null): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const nick = sanitizeIrcNick(v);
  return nick === 'user' && v.toLowerCase() !== 'user' ? null : nick;
}

// ?nick=, ?channel= (with or without its #) or a #channel fragment, ?join=1.
export function parseGuestFirstLink(search: string, hash = ''): GuestFirstLink {
  const q = new URLSearchParams(search);
  const rawChannel = q.get('channel')?.trim() || (hash.length > 1 ? decodeURIComponent(hash.slice(1)) : '');
  const channel = rawChannel ? (/^[#&]/.test(rawChannel) ? rawChannel : `#${rawChannel}`) : '';
  const join = q.get('join');
  return {
    nick: cleanNick(q.get('nick')),
    channel: validChannel(channel) ? channel : null,
    join: join === '1' || join === 'true' || join === 'yes',
  };
}

// The link the page was opened with, read once (and dropped from the
// address bar, so a reload doesn't join again). Web only.
let pageLink: GuestFirstLink | null = null;

export function guestFirstLink(): GuestFirstLink {
  if (pageLink) return pageLink;
  pageLink = NO_LINK;
  try {
    const loc = (globalThis as { location?: Location }).location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return pageLink;
    const link = parseGuestFirstLink(loc.search, loc.hash);
    pageLink = link;
    if (link.nick || link.channel || link.join) {
      const u = new URL(loc.href);
      for (const k of ['nick', 'channel', 'join']) u.searchParams.delete(k);
      if (link.channel && u.hash) u.hash = '';
      history.replaceState(history.state, '', u.toString());
    }
  } catch { /* not a browser */ }
  return pageLink;
}

// The page link's channel was used (landed on, or refused).
export function consumeLinkChannel(): void {
  if (pageLink?.channel) pageLink = { ...pageLink, channel: null };
}

export function __setGuestFirstLinkForTests(link: Partial<GuestFirstLink> | null): void {
  pageLink = link ? { ...NO_LINK, ...link } : null;
}

// ---- landing after "Join chat" ----

export interface GuestLanding {
  // The channel to show.
  focus: string | null;
  // Joined too, in the background (the network's auto-join channels).
  channels: string[];
}

let landing: GuestLanding | null = null;

export function setGuestLanding(l: GuestLanding | null): void {
  landing = l;
}

// Once: the chat screen joins these on the home network.
export function takeGuestLanding(): GuestLanding | null {
  const l = landing;
  landing = null;
  return l;
}

// ---- nick collisions ----

// What to do about the guest's nick on the home network's connection: the
// server took another one (433: in use, so it's "ZestyKiwi_") while the
// guest's nick was made for them: try a fresh friendly nick ('try'), or
// keep the one the server accepted ('keep'). null: nothing to do.
export function guestNickStep(o: {
  guestNick: string;
  current: string;
  tried: readonly string[];
  attempts: number;
  maxAttempts?: number;
}): { kind: 'keep'; nick: string } | { kind: 'try' } | null {
  const cur = o.current.toLowerCase();
  if (!cur || cur === o.guestNick.toLowerCase()) return null;
  if (o.tried.some((t) => t.toLowerCase() === cur)) return { kind: 'keep', nick: o.current };
  return o.attempts < (o.maxAttempts ?? 5) ? { kind: 'try' } : null;
}
