// Ergo's built-in ChanServ (ergo/irc/chanserv.go, v2.19).
//
//   INFO #c               "Channel #c is registered" / "Founder: x" / "Registered at: <RFC1123>"
//                         "Channel #c is not registered"
//   REGISTER #c           "Channel #c successfully registered" (+ MODE #c +q you)
//   AMODE #c [+o acct]    "Channel #c has N persistent modes set" / "Account x receives mode +o"
//   TRANSFER #c acct      → "To confirm your channel transfer, type: /CS TRANSFER #c acct <code>"
//                         → "Transfer of channel #c to account acct succeeded, pending acceptance"
//   TRANSFER ACCEPT #c    "Successfully accepted ownership of channel #c"
//   UNREGISTER #c         → "To confirm, run this command: /CS UNREGISTER #c <code>"
//                         → "Channel #c is now unregistered"
//   SET/GET #c history    "Successfully changed the channel settings" / "The stored channel history setting is: x"
//
// Ergo has no ChanServ topic lock or guard (ChanServ never joins channels):
// a registered channel keeps its modes, so +t is the topic lock there.
import type { AccessEntry, AccessResult, ChanRole, ChanServResult, InfoResult, Operation } from '../chanserv.types';
import { anyLine, done, err, matchError, plain, rxEscape, simpleStep, unreadable, type ErrorRule } from '../text';
import type { ChanServAdapter } from './adapter';

const ERRORS: readonly ErrorRule[] = [
  [/not logged into an account/i, 'not-logged-in'],
  [/disabled by the server administrators/i, 'disabled'],
  [/^Command restricted/i, 'access-denied'],
  [/^Unknown command/i, 'unsupported'],
  [/restricted to server operators/i, 'operator-only'],
  [/must be an oper on the channel/i, 'not-opped'],
  [/maximum number of channels/i, 'limit-reached'],
  [/already registered/i, 'already-registered'],
  [/purged/i, 'closed'],
  [/(?:That channel|Channel) is not registered|^Channel \S+ is not registered/i, 'not-registered'],
  [/^(?:No such channel|Channel does not exist|Invalid channel name)/i, 'no-such-channel'],
  [/^(?:Account does not exist|Could not find given client)/i, 'no-such-account'],
  [/^(?:Insufficient privileges|You don't own that channel|Only the channel founder)/i, 'access-denied'],
  [/^(?:You weren't offered ownership)/i, 'access-denied'],
  [/^(?:Invalid parameters|Invalid params|Invalid mode change)/i, 'invalid'],
  [/^(?:Could not transfer channel|Could not accept ownership|Internal error|An error occurred)/i, 'failed'],
];

const ROLE_MODE: Record<ChanRole, string> = { founder: 'q', admin: 'a', op: 'o', halfop: 'h', voice: 'v' };
const MODE_ROLE: Record<string, ChanRole> = { q: 'founder', a: 'admin', o: 'op', h: 'halfop', v: 'voice' };

const HISTORY_CHOICES = [
  { value: 'default', label: 'Server default' },
  { value: 'on', label: 'Kept (stored)' },
  { value: 'ephemeral', label: 'Recent only (not stored)' },
  { value: 'off', label: 'Off' },
] as const;

export class ErgoChanServ implements ChanServAdapter {
  readonly id = 'ergo' as const;
  readonly label = 'Ergo';
  readonly serviceNick = 'ChanServ';
  readonly caps = {
    info: true,
    register: true,
    registerDescription: false,
    transfer: 'code-accept' as const,
    unregister: true,
    access: true,
    roles: ['founder', 'admin', 'op', 'halfop', 'voice'] as const,
    options: [
      { id: 'history', label: 'Message history', hint: 'How much of the channel\'s history the server keeps for people who join later', choices: HISTORY_CHOICES },
    ],
  };

  info(channel: string): Operation<InfoResult> {
    return {
      first: `INFO ${channel}`,
      step: (lines, settled) => parseErgoInfo(channel, lines, settled),
    };
  }

  readSettings(channel: string): Operation<InfoResult> {
    return {
      first: `GET ${channel} history`,
      step: (lines, settled) => {
        const m = anyLine(lines, /^The stored channel history setting is:\s*(\S+)/i);
        if (m) return { final: { kind: 'info', info: { channel, registered: true, values: { history: m[1]!.toLowerCase() } }, lines: [...lines] } };
        const e = matchError(lines, ERRORS);
        if (e) return { final: e };
        return settled ? { final: unreadable(lines) } : null;
      },
    };
  }

  register(channel: string): Operation<ChanServResult> {
    return {
      first: `REGISTER ${channel}`,
      step: (lines, settled) => simpleStep(lines, settled, [/successfully registered/i], ERRORS),
    };
  }

  transfer(channel: string, account: string): Operation<ChanServResult> {
    return {
      first: `TRANSFER ${channel} ${account}`,
      step: (lines, settled) => {
        // The confirmation-code prompt: the user already confirmed in the UI,
        // so replay the command the server asked for.
        const code = anyLine(lines, /To confirm your channel transfer, type: \/CS TRANSFER (\S+) (\S+) (\S+)/i);
        if (code) return { send: `TRANSFER ${code[1]} ${code[2]} ${code[3]}` };
        if (anyLine(lines, /succeeded, pending acceptance/i)) return { final: done(lines, { pending: true }) };
        return simpleStep(lines, settled, [/^Successfully transferred channel/i], ERRORS, [/^Cancelled pending transfer/i]);
      },
    };
  }

  acceptTransfer(channel: string): Operation<ChanServResult> {
    return {
      first: `TRANSFER ACCEPT ${channel}`,
      step: (lines, settled) => simpleStep(lines, settled, [/^Successfully accepted ownership/i], ERRORS),
    };
  }

  unregister(channel: string): Operation<ChanServResult> {
    return {
      first: `UNREGISTER ${channel}`,
      step: (lines, settled) => {
        const code = anyLine(lines, /To confirm, run this command: \/CS UNREGISTER (\S+) (\S+)/i);
        if (code) return { send: `UNREGISTER ${code[1]} ${code[2]}` };
        return simpleStep(lines, settled, [/is now unregistered/i], ERRORS);
      },
    };
  }

  listAccess(channel: string): Operation<AccessResult> {
    return {
      first: `AMODE ${channel}`,
      step: (lines, settled) => {
        const head = anyLine(lines, /^Channel \S+ has (\d+) persistent modes? set/i);
        const entries: AccessEntry[] = [];
        for (const line of lines) {
          const m = plain(line).match(/^Account (\S+) receives mode \+([a-zA-Z])/);
          if (m) entries.push({ account: m[1]!, role: MODE_ROLE[m[2]!] ?? null, raw: `+${m[2]}` });
        }
        if (head && entries.length >= Number(head[1])) return { final: { kind: 'access', entries, lines: [...lines] } };
        if (head && settled) return { final: { kind: 'access', entries, lines: [...lines] } };
        const e = matchError(lines, ERRORS);
        if (e) return { final: e };
        return settled ? { final: unreadable(lines) } : null;
      },
    };
  }

  setAccess(channel: string, account: string, role: ChanRole | null, previous?: ChanRole | null): Operation<ChanServResult> {
    // Ergo keeps one persistent mode per account: +<new> replaces the old one;
    // removing needs the mode it has.
    const change = role ? `+${ROLE_MODE[role]}` : previous ? `-${ROLE_MODE[previous]}` : null;
    if (!change) return { first: `AMODE ${channel}`, step: (lines) => ({ final: done(lines, { nochange: true }) }) };
    return {
      first: `AMODE ${channel} ${change} ${account}`,
      step: (lines, settled) => simpleStep(lines, settled, [/^Successfully set persistent mode/i], ERRORS, [/^No changes were made/i]),
    };
  }

  setOption(channel: string, option: string, value: boolean | string): Operation<ChanServResult> {
    const v = typeof value === 'string' ? value : value ? 'on' : 'off';
    return {
      first: `SET ${channel} ${option} ${v}`,
      step: (lines, settled) => simpleStep(lines, settled, [/^Successfully changed the channel settings/i], ERRORS),
    };
  }

  transferOffer(line: string): string | null {
    const m = plain(line).match(/You have been offered ownership of channel (\S+?)\.?\s+To accept/i);
    return m ? m[1]! : null;
  }
}

export function parseErgoInfo(channel: string, lines: readonly string[], settled: boolean): ReturnType<Operation<InfoResult>['step']> {
  const ch = rxEscape(channel);
  const closed = !!anyLine(lines, /was purged by the server operators/i);
  if (anyLine(lines, new RegExp(`^Channel ${ch} is not registered`, 'i')) || anyLine(lines, /^Channel \S+ is not registered$/i)) {
    return { final: { kind: 'info', info: { channel, registered: false, ...(closed ? { closed } : {}) }, lines: [...lines] } };
  }
  const reg = anyLine(lines, /^Channel (\S+) is registered$/i);
  if (reg) {
    // Ergo sends the whole block at once; wait for the quiet period anyway so
    // extra lines (a patched server's "Last activity") are part of it.
    if (!settled) return null;
    const founder = anyLine(lines, /^Founder:\s*(\S+)/i)?.[1];
    const registeredAt = anyLine(lines, /^Registered at:\s*(.+)$/i)?.[1]?.trim();
    const lastUsed = anyLine(lines, /^Last (?:used|activity|active):\s*(.+)$/i)?.[1]?.trim();
    const expires = anyLine(lines, /^Expires(?: at| on)?:\s*(.+)$/i)?.[1]?.trim();
    if (!founder) return { final: unreadable(lines) };
    return {
      final: {
        kind: 'info',
        info: {
          channel: reg[1]!, registered: true, founder,
          ...(registeredAt ? { registeredAt } : {}),
          ...(lastUsed ? { lastUsed } : {}),
          ...(expires ? { expires } : {}),
          ...(closed ? { closed } : {}),
        },
        lines: [...lines],
      },
    };
  }
  // A purge notice comes before the registration line: wait for it.
  if (closed) return settled ? { final: { kind: 'info', info: { channel, registered: false, closed }, lines: [...lines] } } : null;
  const e = matchError(lines, ERRORS);
  if (e) return { final: e };
  return settled ? { final: lines.length ? unreadable(lines) : err('timeout', lines) } : null;
}
