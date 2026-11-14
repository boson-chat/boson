// Which channel-services package a network runs.
//
// Signals, strongest first:
//   1. The engine's services verdict (engine/irc/services.go): NickServ /
//      ChanServ VERSION + HELP probes branded "Anope", "Atheme", "Ergo".
//   2. The server software (RPL_MYINFO 004 version) — Ergo's ChanServ is
//      built in, so "ergo-2.19.1" settles it; ircu ("u2.10.12.19") means
//      Undernet's X, snircd ("u2.10.12.10+snircd(…)") QuakeNet's Q, bahamut
//      DALnet's ChanServ.
//   3. The network name (ISUPPORT NETWORK=): Undernet, QuakeNet, DALnet,
//      Libera.Chat (Atheme).
//   4. ChanServ's own reply text, when it has answered something (the INFO
//      header shapes differ per package).
//
// Undecided → 'generic': INFO is probed read-only and an unrecognised reply
// reads as "couldn't read", never as a state.
import type { ChanServDialect } from './chanserv.types';
import { plain } from './text';

export interface DialectSignals {
  // Engine verdict, null until it settles.
  framework?: 'atheme' | 'anope' | 'ergo' | 'unknown' | null;
  // RPL_MYINFO version string.
  version?: string;
  // ISUPPORT NETWORK=.
  network?: string;
  // ChanServ reply lines seen so far (any command).
  chanservLines?: readonly string[];
}

export function dialectFromVersion(version: string | undefined): ChanServDialect | null {
  if (!version) return null;
  const v = version.toLowerCase();
  if (/^ergo-|^oragono-/.test(v)) return 'ergo';
  if (/snircd|u2\.10\.h/.test(v)) return 'q';
  if (/^u2\.\d+/.test(v) || /^ircu/.test(v)) return 'x';
  if (/bahamut/.test(v)) return 'generic';
  return null;
}

export function dialectFromNetwork(network: string | undefined): ChanServDialect | null {
  if (!network) return null;
  const n = network.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n === 'undernet') return 'x';
  if (n === 'quakenet') return 'q';
  if (n === 'dalnet') return 'generic';
  if (n === 'liberachat' || n === 'libera') return 'atheme';
  return null;
}

// Reply-text fingerprints: the INFO / error shapes each package prints.
export function dialectFromReplies(lines: readonly string[] | undefined): ChanServDialect | null {
  for (const raw of lines ?? []) {
    const l = plain(raw);
    if (/^Information for channel \S+:/i.test(l) || /^Channel \S+ isn't registered\./i.test(l)) return 'anope';
    if (/^Information on \S+:$/i.test(l) || /^\*\*\* End of Info \*\*\*/.test(l)) return 'atheme';
    if (/\/CS (?:HELP|TRANSFER|UNREGISTER)\b/.test(l) || /^Channel \S+ is (?:not )?registered$/.test(l)) return 'ergo';
    if (/\banope\b/i.test(l)) return 'anope';
    if (/\batheme\b/i.test(l)) return 'atheme';
  }
  return null;
}

export function detectChanServDialect(s: DialectSignals): ChanServDialect | null {
  const fromVersion = dialectFromVersion(s.version);
  // Ergo's services are part of the ircd; nothing else can be answering.
  if (fromVersion === 'ergo') return 'ergo';
  if (s.framework === 'ergo' || s.framework === 'anope' || s.framework === 'atheme') return s.framework;
  // ircu networks have no ChanServ at all — X / Q are the only channel service.
  if (fromVersion === 'x' || fromVersion === 'q') return fromVersion;
  const fromNetwork = dialectFromNetwork(s.network);
  if (fromNetwork) return fromNetwork;
  const fromReplies = dialectFromReplies(s.chanservLines);
  if (fromReplies) return fromReplies;
  if (fromVersion) return fromVersion;
  // The engine looked and found nothing it knows: read-only generic.
  if (s.framework === 'unknown') return 'generic';
  return null;
}
