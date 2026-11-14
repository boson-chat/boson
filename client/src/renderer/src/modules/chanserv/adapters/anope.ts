// Anope 2.x ChanServ (anope/modules/commands/cs_*.cpp, include/language.h).
//
//   INFO #c                 "Information for channel #c:" then right-aligned
//                           "Key: value" rows (Founder, Registered, Last used,
//                           Options, Expires, …) — no footer
//                           "Channel #c isn't registered."
//   REGISTER #c [desc]      "Channel #c registered under your account: x"
//   SET FOUNDER #c acct     "Founder of #c changed to acct."  (immediate)
//   DROP #c #c              "Channel #c has been dropped."   (name twice = confirmation)
//   ACCESS #c LIST          "Access list for #c:" / header / rows / "End of access list"
//   SOP|AOP|HOP|VOP|QOP #c ADD acct    "acct added to #c AOP list."  (replaces an older entry)
//   ACCESS #c DEL acct      "acct deleted from #c access list."
//   SET KEEPTOPIC|SECURE|… #c ON|OFF   "… option for #c is now on."
//   TOPIC #c LOCK|UNLOCK    "Topic lock option for #c is now on."
//
// Note the argument order: Anope's SET is `SET <option> <#channel>`.
import type { AccessEntry, AccessResult, ChanRole, ChanServResult, ChannelRegistration, InfoResult, Operation } from '../chanserv.types';
import { anyLine, matchError, plain, rxEscape, simpleStep, unreadable, type ErrorRule } from '../text';
import type { ChanServAdapter } from './adapter';

const ERRORS: readonly ErrorRule[] = [
  [/must be logged into an account|Password authentication required/i, 'not-logged-in'],
  [/must confirm your account/i, 'not-confirmed'],
  [/temporarily disabled/i, 'disabled'],
  [/^Unknown command/i, 'unsupported'],
  [/already (?:reached|exceeded) your limit of/i, 'limit-reached'],
  [/you can only have \d+ access entries/i, 'limit-reached'],
  [/must be a channel operator to register/i, 'not-opped'],
  [/is already registered/i, 'already-registered'],
  [/^Channel \S+ isn't registered/i, 'not-registered'],
  [/^Channel \S+ doesn't exist/i, 'no-such-channel'],
  [/^(?:Local channels cannot be registered|Please use a symbol|Channel \S+ is not a valid channel)/i, 'invalid'],
  [/is currently suspended|is forbidden/i, 'closed'],
  [/^Nick \S+ isn't registered/i, 'no-such-account'],
  [/^Masks and unregistered users may not be on access lists/i, 'no-such-account'],
  [/^Access denied/i, 'access-denied'],
  [/^Syntax:/i, 'invalid'],
];

// Option labels Anope prints in INFO's "Options:" row, by option id.
const OPTION_LABELS: Record<string, string> = {
  'topic retention': 'keeptopic',
  'topic lock': 'topiclock',
  'security': 'secure',
  'secure ops': 'secureops',
  'secure founder': 'securefounder',
  'peace': 'peace',
  'restricted access': 'restricted',
  'private': 'private',
  'signed kicks': 'signkick',
  'keep modes': 'keepmodes',
  'persistent': 'persist',
  'no expire': 'noexpire',
};

const XOP: Record<ChanRole, string> = { founder: 'QOP', admin: 'SOP', op: 'AOP', halfop: 'HOP', voice: 'VOP' };

export class AnopeChanServ implements ChanServAdapter {
  readonly id = 'anope' as const;
  readonly label = 'Anope';
  readonly serviceNick = 'ChanServ';
  readonly caps = {
    info: true,
    register: true,
    registerDescription: true,
    transfer: 'direct' as const,
    unregister: true,
    access: true,
    roles: ['founder', 'admin', 'op', 'halfop', 'voice'] as const,
    options: [
      { id: 'topiclock', label: 'Topic lock', hint: 'Only people with access can change the topic' },
      { id: 'keeptopic', label: 'Keep topic', hint: 'Restore the topic when the channel empties and is used again' },
      { id: 'secureops', label: 'Secure ops', hint: 'Only people on the access list can be opped' },
      { id: 'restricted', label: 'Restricted', hint: 'People not on the access list are kicked on join' },
      { id: 'peace', label: 'Peace', hint: 'Nobody can kick or ban someone with more access than them' },
      { id: 'private', label: 'Private', hint: 'Hide the channel from ChanServ LIST' },
      { id: 'secure', label: 'Secure', hint: 'Access only applies to people logged into the account' },
    ],
  };

  info(channel: string): Operation<InfoResult> {
    return { first: `INFO ${channel}`, step: (lines, settled) => parseAnopeInfo(channel, lines, settled) };
  }

  register(channel: string, description?: string): Operation<ChanServResult> {
    const desc = description?.trim();
    return {
      first: desc ? `REGISTER ${channel} ${desc}` : `REGISTER ${channel}`,
      step: (lines, settled) => simpleStep(lines, settled, [/^Channel \S+ registered under your account/i], ERRORS),
    };
  }

  transfer(channel: string, account: string): Operation<ChanServResult> {
    return {
      first: `SET FOUNDER ${channel} ${account}`,
      step: (lines, settled) => simpleStep(lines, settled, [/^Founder of \S+ changed to/i], [
        [/^Nick \S+ isn't registered/i, 'no-such-account'],
        [/has too many channels registered|reached .*limit/i, 'limit-reached'],
        ...ERRORS,
      ]),
    };
  }

  unregister(channel: string): Operation<ChanServResult> {
    return {
      first: `DROP ${channel} ${channel}`,
      step: (lines, settled) => {
        if (anyLine(lines, /must enter the channel name twice/i)) return { send: `DROP ${channel} ${channel}` };
        return simpleStep(lines, settled, [/^Channel \S+ has been dropped/i], ERRORS);
      },
      maxFollowUps: 1,
    };
  }

  listAccess(channel: string): Operation<AccessResult> {
    return {
      first: `ACCESS ${channel} LIST`,
      step: (lines, settled) => {
        if (anyLine(lines, /access list is empty|^No matching entries on/i)) return { final: { kind: 'access', entries: [], lines: [...lines] } };
        const head = anyLine(lines, /^Access list for \S+:/i);
        const end = anyLine(lines, /^End of access list/i);
        if (head && (end || settled)) return { final: { kind: 'access', entries: parseAnopeAccessRows(lines), lines: [...lines] } };
        const e = matchError(lines, ERRORS);
        if (e) return { final: e };
        return settled ? { final: unreadable(lines) } : null;
      },
    };
  }

  setAccess(channel: string, account: string, role: ChanRole | null): Operation<ChanServResult> {
    if (role) {
      const xop = XOP[role];
      return {
        first: `${xop} ${channel} ADD ${account}`,
        step: (lines, settled) => simpleStep(lines, settled, [new RegExp(`added to \\S+ ${xop} list`, 'i')], ERRORS),
      };
    }
    return {
      first: `ACCESS ${channel} DEL ${account}`,
      step: (lines, settled) => simpleStep(lines, settled,
        [/deleted from \S+ access list|^Deleted \d+ entr/i], ERRORS, [/not found on \S+ access list|^No matching entries/i]),
    };
  }

  setOption(channel: string, option: string, value: boolean | string): Operation<ChanServResult> {
    const on = value === true || value === 'on';
    const first = option === 'topiclock'
      ? `TOPIC ${channel} ${on ? 'LOCK' : 'UNLOCK'}`
      : `SET ${option.toUpperCase()} ${channel} ${on ? 'ON' : 'OFF'}`;
    return {
      first,
      step: (lines, settled) => simpleStep(lines, settled, [/ is now (?:on|off)\b/i, /^Services will (?:now|no longer)/i], ERRORS),
    };
  }
}

// "  Founder: alice" rows, keys right-aligned by InfoFormatter.
function infoRow(lines: readonly string[], key: string): string | undefined {
  const m = anyLine(lines, new RegExp(`^\\s*${rxEscape(key)}:\\s*(.*)$`, 'i'));
  const v = m?.[1]?.trim();
  return v ? v : undefined;
}

export function parseAnopeInfo(channel: string, lines: readonly string[], settled: boolean): ReturnType<Operation<InfoResult>['step']> {
  if (anyLine(lines, /^Channel \S+ isn't registered/i)) {
    return { final: { kind: 'info', info: { channel, registered: false }, lines: [...lines] } };
  }
  const head = anyLine(lines, /^Information for channel (\S+?):?$/i);
  if (head) {
    if (!settled) return null;
    const founder = infoRow(lines, 'Founder');
    const info: ChannelRegistration = { channel: head[1]!, registered: true };
    if (founder) info.founder = founder;
    const map: Array<[keyof ChannelRegistration, string]> = [
      ['successor', 'Successor'], ['description', 'Description'], ['registeredAt', 'Registered'],
      ['lastUsed', 'Last used'], ['expires', 'Expires'],
    ];
    for (const [field, key] of map) {
      const v = infoRow(lines, key);
      if (v) (info as unknown as Record<string, string>)[field] = v;
    }
    if (infoRow(lines, 'Suspended')) info.closed = true;
    // Options are shown only to people with INFO access (who also see "Ban
    // type"); without either we don't know them.
    const opts = infoRow(lines, 'Options');
    if (opts !== undefined || infoRow(lines, 'Ban type') !== undefined) {
      const on: Record<string, boolean> = {};
      for (const label of (opts ?? '').split(',')) {
        const id = OPTION_LABELS[label.trim().toLowerCase()];
        if (id) on[id] = true;
      }
      info.options = on;
    }
    // A header with neither a founder nor a registration time isn't a block
    // we understood (translated keys): don't guess.
    if (!info.founder && !info.registeredAt) return { final: unreadable(lines) };
    return { final: { kind: 'info', info, lines: [...lines] } };
  }
  const e = matchError(lines, ERRORS);
  if (e) return { final: e };
  return settled ? { final: unreadable(lines) } : null;
}

const LEVEL_ROLE: Record<string, ChanRole> = { QOP: 'founder', SOP: 'admin', AOP: 'op', HOP: 'halfop', VOP: 'voice' };

// Map an ACCESS LIST "Level" cell onto the role ladder: an XOP name, a numeric
// level (default levels: founder 10000, AUTOPROTECT 10, AUTOOP 5,
// AUTOHALFOP 4, AUTOVOICE 3), or a FLAGS letter set.
export function anopeLevelRole(level: string): ChanRole | null {
  const up = level.toUpperCase();
  if (LEVEL_ROLE[up]) return LEVEL_ROLE[up]!;
  if (/^-?\d+$/.test(level)) {
    const n = Number(level);
    if (n >= 10000) return 'founder';
    if (n >= 10) return 'admin';
    if (n >= 5) return 'op';
    if (n >= 4) return 'halfop';
    if (n >= 3) return 'voice';
    return null;
  }
  const flags = level.replace(/^\+/, '');
  if (/^[a-zA-Z]+$/.test(flags)) {
    if (flags.includes('F')) return 'founder';
    if (flags.includes('a')) return 'admin';
    if (flags.includes('o')) return 'op';
    if (flags.includes('h')) return 'halfop';
    if (flags.includes('v')) return 'voice';
  }
  return null;
}

export function parseAnopeAccessRows(lines: readonly string[]): AccessEntry[] {
  const out: AccessEntry[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = plain(raw);
    if (/^Access list for /i.test(line)) { inList = true; continue; }
    if (/^End of access list/i.test(line)) break;
    if (!inList) continue;
    // "1       AOP    alice" (Number, Level, Mask; extra columns ignored).
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    out.push({ account: m[3]!, role: anopeLevelRole(m[2]!), raw: m[2]! });
  }
  return out;
}

