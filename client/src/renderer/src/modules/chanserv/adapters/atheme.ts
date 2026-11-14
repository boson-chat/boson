// Atheme ChanServ (atheme/modules/chanserv/*.c, 7.2 and current master) —
// Libera.Chat and many Solanum/InspIRCd networks.
//
//   INFO #c               "Information on #c:" / "Founder    : x" / "Registered : … (… ago)"
//                         / "Last used  : …" / "Flags      : GUARD SECURE …" / "*** End of Info ***"
//                         "#c is not registered." (7.2: "Channel #c is not registered.")
//   REGISTER #c           "#c is now registered to x."
//   FLAGS #c              table rows, "End of #c FLAGS listing."
//   FLAGS #c acct AOP     "Flags +… were set on acct in #c."   (templates replace)
//   FLAGS #c acct -*      removes an entry
//   DROP #c               → "… Please confirm by replying with /msg ChanServ DROP #c <key>"
//                         → "The channel #c has been dropped."
//   SET #c GUARD ON|OFF   "The GUARD flag has been set for channel #c."
//
// Atheme has no SET FOUNDER (removed before 7.x): a channel can have several
// founders (+F), so handing it over is "give them +F, then drop your own +F".
import type { AccessEntry, AccessResult, ChanRole, ChanServResult, ChannelRegistration, InfoResult, Operation } from '../chanserv.types';
import { anyLine, matchError, plain, simpleStep, unreadable, type ErrorRule } from '../text';
import type { ChanServAdapter } from './adapter';

const ERRORS: readonly ErrorRule[] = [
  [/^You are not logged in/i, 'not-logged-in'],
  [/must verify your e-?mail address/i, 'not-confirmed'],
  [/^Invalid command\. Use/i, 'unsupported'],
  [/too many channels registered/i, 'limit-reached'],
  [/access list is full/i, 'limit-reached'],
  [/must be a channel operator in/i, 'not-opped'],
  [/^You must be in \S+ in order to register it/i, 'not-in-channel'],
  [/must exist in order to register it/i, 'no-such-channel'],
  [/is already registered/i, 'already-registered'],
  [/restricted from registering channels/i, 'access-denied'],
  [/has been closed down|is closed|is held/i, 'closed'],
  [/^(?:Channel )?#\S* is not registered/i, 'not-registered'],
  [/^\S+ is not registered/i, 'no-such-account'],
  [/^You are not authorized to perform this|^You are not allowed to set|^You may not remove/i, 'access-denied'],
  [/^Invalid key for/i, 'failed'],
  [/^(?:Insufficient parameters|Invalid parameters|Syntax:|Usage:|No valid flags given|Invalid template name)/i, 'invalid'],
  [/too busy to process/i, 'busy'],
];

const OPTION_FLAGS: Record<string, string> = {
  GUARD: 'guard', KEEPTOPIC: 'keeptopic', TOPICLOCK: 'topiclock', SECURE: 'secure',
  RESTRICTED: 'restricted', PRIVATE: 'private', VERBOSE: 'verbose',
};

const TEMPLATE: Record<Exclude<ChanRole, 'founder'>, string> = { admin: 'SOP', op: 'AOP', halfop: 'HOP', voice: 'VOP' };
const TEMPLATE_ROLE: Record<string, ChanRole> = { FOUNDER: 'founder', SOP: 'admin', AOP: 'op', HOP: 'halfop', VOP: 'voice' };

export class AthemeChanServ implements ChanServAdapter {
  readonly id = 'atheme' as const;
  readonly label = 'Atheme';
  readonly serviceNick = 'ChanServ';
  readonly caps = {
    info: true,
    register: true,
    registerDescription: false,
    transfer: 'flags' as const,
    unregister: true,
    access: true,
    roles: ['founder', 'admin', 'op', 'halfop', 'voice'] as const,
    options: [
      { id: 'guard', label: 'Guard', hint: 'ChanServ sits in the channel and enforces its settings' },
      { id: 'topiclock', label: 'Topic lock', hint: 'Only people with topic access can change the topic' },
      { id: 'keeptopic', label: 'Keep topic', hint: 'Restore the topic when the channel empties and is used again' },
      { id: 'secure', label: 'Secure', hint: 'Only people on the access list can be opped' },
      { id: 'restricted', label: 'Restricted', hint: 'People not on the access list are kicked on join' },
      { id: 'private', label: 'Private', hint: 'Hide the channel\'s details from people without access' },
      { id: 'verbose', label: 'Verbose', hint: 'Announce access-list changes in the channel' },
    ],
  };

  info(channel: string): Operation<InfoResult> {
    return { first: `INFO ${channel}`, step: (lines, settled) => parseAthemeInfo(channel, lines, settled) };
  }

  register(channel: string): Operation<ChanServResult> {
    return {
      first: `REGISTER ${channel}`,
      step: (lines, settled) => simpleStep(lines, settled, [/is now registered to/i], ERRORS),
    };
  }

  // Give the new founder +F, then drop our own +F (we keep our other flags,
  // so the old founder stays an op until the new one changes that).
  transfer(channel: string, account: string, self: string): Operation<ChanServResult> {
    let granted = false;
    return {
      first: `FLAGS ${channel} ${account} +F`,
      maxFollowUps: 1,
      step: (lines, settled) => {
        if (!granted) {
          if (anyLine(lines, /^Flags \S+ were set on/i) || anyLine(lines, /^Channel access to \S+ for \S+ unchanged/i)) {
            granted = true;
            return { send: `FLAGS ${channel} ${self} -F` };
          }
          const e = matchError(lines, ERRORS);
          if (e) return { final: e };
          return settled ? { final: unreadable(lines) } : null;
        }
        return simpleStep(lines, settled, [/^Flags \S+ were set on/i], ERRORS, [/unchanged/i]);
      },
    };
  }

  unregister(channel: string): Operation<ChanServResult> {
    return {
      first: `DROP ${channel}`,
      maxFollowUps: 1,
      step: (lines, settled) => {
        // The key prompt: replay the server's own command verbatim.
        const m = anyLine(lines, /confirm by replying with\s+\/msg\s+\S+\s+(DROP\s+\S+\s+\S+?)\.?$/i);
        if (m) return { send: m[1]! };
        return simpleStep(lines, settled, [/^The channel \S+ has been dropped/i], ERRORS);
      },
    };
  }

  listAccess(channel: string): Operation<AccessResult> {
    return {
      first: `FLAGS ${channel}`,
      step: (lines, settled) => {
        if (anyLine(lines, /^End of \S+ FLAGS listing/i)) return { final: { kind: 'access', entries: parseAthemeFlagsRows(lines), lines: [...lines] } };
        const e = matchError(lines, ERRORS);
        if (e) return { final: e };
        return settled ? { final: unreadable(lines) } : null;
      },
    };
  }

  setAccess(channel: string, account: string, role: ChanRole | null): Operation<ChanServResult> {
    const spec = role === null ? '-*' : role === 'founder' ? '+F' : TEMPLATE[role];
    return {
      first: `FLAGS ${channel} ${account} ${spec}`,
      step: (lines, settled) => simpleStep(lines, settled, [/^Flags \S+ were set on/i], ERRORS, [/^Channel access to \S+ for \S+ unchanged/i]),
    };
  }

  setOption(channel: string, option: string, value: boolean | string): Operation<ChanServResult> {
    const on = value === true || value === 'on';
    return {
      first: `SET ${channel} ${option.toUpperCase()} ${on ? 'ON' : 'OFF'}`,
      step: (lines, settled) => simpleStep(lines, settled,
        [/^The \S+ flag has been (?:set|removed) for/i], ERRORS, [/^The \S+ flag is (?:already|not) set for/i]),
    };
  }
}

function row(lines: readonly string[], key: string): string | undefined {
  const m = anyLine(lines, new RegExp(`^${key}\\s*:\\s*(.*)$`, 'i'));
  const v = m?.[1]?.trim();
  return v ? v : undefined;
}

export function parseAthemeInfo(channel: string, lines: readonly string[], settled: boolean): ReturnType<Operation<InfoResult>['step']> {
  if (anyLine(lines, /^(?:Channel )?#\S* is not registered/i)) {
    return { final: { kind: 'info', info: { channel, registered: false }, lines: [...lines] } };
  }
  if (anyLine(lines, /has been closed down by the/i)) {
    return { final: { kind: 'info', info: { channel, registered: true, closed: true }, lines: [...lines] } };
  }
  const head = anyLine(lines, /^Information on (\S+?):?$/i);
  const end = anyLine(lines, /^\*\*\* End of Info \*\*\*/i);
  if (head && (end || settled)) {
    const info: ChannelRegistration = { channel: head[1]!, registered: true };
    const founder = row(lines, 'Founder')?.split(/[\s,]+/)[0];
    if (founder) info.founder = founder;
    const successor = row(lines, 'Successor');
    if (successor && successor !== '(none)') info.successor = successor;
    const reg = row(lines, 'Registered');
    if (reg) info.registeredAt = reg;
    const used = row(lines, 'Last used');
    if (used) info.lastUsed = used.replace(/^\((.*)\)$/, '$1');
    if (anyLine(lines, /was CLOSED by/i)) info.closed = true;
    // "Flags" lists the options that are on; no row means none are.
    if (end) {
      const on: Record<string, boolean> = {};
      for (const f of (row(lines, 'Flags') ?? '').split(/\s+/)) {
        const id = OPTION_FLAGS[f.toUpperCase()];
        if (id) on[id] = true;
      }
      info.options = on;
    }
    if (!info.founder && !info.registeredAt) return { final: unreadable(lines) };
    return { final: { kind: 'info', info, lines: [...lines] } };
  }
  if (head) return null;
  const e = matchError(lines, ERRORS);
  if (e) return { final: e };
  return settled ? { final: unreadable(lines) } : null;
}

// Atheme flag letters → role (+F founder, +a/+q protect, +o/+O op, +h/+H halfop, +v/+V voice).
export function athemeFlagsRole(flags: string, template?: string): ChanRole | null {
  if (template && TEMPLATE_ROLE[template.toUpperCase()]) return TEMPLATE_ROLE[template.toUpperCase()]!;
  const f = flags.replace(/^\+/, '');
  if (f.includes('F')) return 'founder';
  if (/[aq]/.test(f)) return 'admin';
  if (/[oO]/.test(f)) return 'op';
  if (/[hH]/.test(f)) return 'halfop';
  if (/[vV]/.test(f)) return 'voice';
  return null;
}

export function parseAthemeFlagsRows(lines: readonly string[]): AccessEntry[] {
  const out: AccessEntry[] = [];
  for (const raw of lines) {
    // "1        alice                  +AFRefiorstv         (FOUNDER) [modified …]"
    const m = plain(raw).match(/^\s*(\d+)\s+(\S+)\s+(\+[a-zA-Z]+)(?:\s+\(([^)]+)\))?/);
    if (!m) continue;
    out.push({ account: m[2]!, role: athemeFlagsRole(m[3]!, m[4]), raw: m[4] ? `${m[3]} (${m[4]})` : m[3]! });
  }
  return out;
}

