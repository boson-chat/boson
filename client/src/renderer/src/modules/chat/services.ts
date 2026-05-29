// Detection of IRC "services" — pseudo-users provided by the network for
// account management, channel management, off-channel memos, etc.
// (NickServ, ChanServ, …). Their NOTICEs are operational chatter, not chat
// content, so the ChatService routes them to a single per-connection
// `~server` pseudo-channel instead of creating a DM-style virtual channel
// per service. They're still readable when the user wants — they're just
// out of the way of real conversations.

// Synthetic channel name used by the chat service to collect all service /
// server messages for a given connection. The `~` prefix is deliberately
// not a valid IRC channel sigil (those are `#` and `&`), so no real channel
// can collide with this name; the channelKey helper preserves case to keep
// the lookup unambiguous.
export const SERVICE_CHANNEL = '~server';

// Display label rendered in the channel sidebar.
export const SERVICE_CHANNEL_LABEL = 'Server';

// Well-known service nicknames. The list mirrors what Atheme + Anope expose
// across the major networks (Libera, OFTC, IRCnet, etc.). Matching is
// case-insensitive — many networks UPPERCASE their service nicks while users
// type them in mixed case.
const SERVICE_NICKS: ReadonlySet<string> = new Set([
  'nickserv',
  'chanserv',
  'operserv',
  'memoserv',
  'botserv',
  'hostserv',
  'saslserv',
  'authserv',
  'aliasserv',
  'groupserv',
  'rootserv',
  'gameserv',
  'statserv',
  'helpserv',
  'global',  // network-wide announcements
]);

// Does this message come from a server-side service / pseudo-user?
//
// Two cases qualify:
//   1. From is a known service nick (case-insensitive)
//   2. From is the server's own hostname (contains a dot but no user@host
//      shape) — typical of raw server NOTICEs ("*** Looking up your hostname")
export function isServiceSender(from: string): boolean {
  if (!from) return true; // anonymous notices are always server-side
  const lower = from.toLowerCase();
  if (SERVICE_NICKS.has(lower)) return true;
  // Heuristic: a sender like "hub.example.org" is a server. Real nicks
  // can't contain `.` (sanitised on connect, and IRC RFCs disallow it).
  if (from.includes('.')) return true;
  return false;
}

// Is this target one the server uses during pre-registration (target=`*`
// before the client has a nick assigned, or `AUTH` from some daemons)?
// These never represent a real conversation and should be routed to the
// service pseudo-channel.
export function isServerWildcardTarget(target: string): boolean {
  return target === '*' || target === 'AUTH';
}

// MemoServ specifically — used by the ChatService to pull MemoServ
// NOTICEs out of the per-server chat log and into the global Inbox.
// Case-insensitive match because networks normalise service casing
// differently (NickServ on Libera, NickServ on OFTC, NICKSERV on
// some older daemons).
export function isMemoServSender(from: string): boolean {
  return from.toLowerCase() === 'memoserv';
}

// The "flavour" of services package the network is running. Atheme and
// Anope are the dominant implementations; their command surfaces overlap
// but diverge enough (atheme's `GROUP` vs. anope's `CONFIRM`, different
// `SET` keys, etc.) that the UI wants to know which one it's talking to.
// `unknown` means we've seen a service interact but couldn't identify
// the package (uncommon — most banners are distinctive); `null` means
// no service has interacted yet.
export type ServicesFramework = 'atheme' | 'anope' | 'ergo' | 'unknown' | null;

// Classify a NOTICE / PRIVMSG body from a service into one of the known
// frameworks. Returns null when no signature is found. Match is case-
// insensitive — both packages name themselves identically across all
// their services (NickServ, ChanServ, MemoServ, HostServ, etc.), so a
// substring match against any service's response is enough.
//
// Sources surveyed (from Atheme + Anope source / docs):
//
//   Atheme (atheme.org):
//     VERSION reply           — "atheme-7.X.Y. Compiled on ..."
//     HELP banner header      — "Atheme IRC Services 7.X.Y."
//     Generic footer          — "(C) atheme.org"
//     Some networks brand it  — "Powered by Atheme"
//
//   Anope (anope.org):
//     VERSION reply           — "Anope-2.0.X" or "Anope IRC Services 2.0.X"
//     HELP banner header      — "Anope IRC Services Help System"
//     Module banners          — "Anope module: ...", "Anope-..."
//
// We accept the bare word `Anope` or `Atheme` anywhere in the body. The
// false-positive risk on normal English is essentially nil — neither
// word is a common noun and they basically never appear in chat
// transcripts outside their own banners.
export function detectServicesFramework(noticeBody: string): ServicesFramework {
  if (!noticeBody) return null;
  // Word-boundary match avoids matching e.g. "panopent" against "anope".
  // Case-insensitive flag makes "ATHEME" / "atheme" / "Atheme" all match.
  if (/\batheme\b/i.test(noticeBody)) return 'atheme';
  if (/\banope\b/i.test(noticeBody)) return 'anope';
  return null;
}
