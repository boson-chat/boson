// Read-only dialects: networks whose channel service we can't (or shouldn't)
// drive from the UI, but whose registration status we can still show.
//
//   Undernet X (GNUworld mod.cservice, CHANINFOCommand.cc):
//     CHANINFO #c   "#c is registered by:" / "<user> - last seen: 3 days ago" / "Desc: …"
//                   "The channel #c is not registered"
//     Registration on Undernet is a web application, not a command.
//   QuakeNet Q: channel info needs channel access and registration goes
//     through a request bot, so nothing is shown (caps all off).
//   Generic ChanServ (DALnet and packages we don't recognise): INFO #c,
//     recognising only the near-universal "Founder: x" / "… isn't registered"
//     shapes. Anything else is "couldn't read", never a guess.
import type { ChannelRegistration, InfoResult, Operation } from '../chanserv.types';
import { anyLine, err, matchError, plain, rxEscape, unreadable, type ErrorRule } from '../text';
import type { ChanServAdapter } from './adapter';

const NO_ACTIONS = {
  register: false,
  registerDescription: false,
  transfer: null,
  unregister: false,
  access: false,
  roles: [],
  options: [],
} as const;

export class UndernetX implements ChanServAdapter {
  readonly id = 'x' as const;
  readonly label = 'Undernet X';
  readonly serviceNick = 'X';
  readonly caps = { info: true, ...NO_ACTIONS };

  info(channel: string): Operation<InfoResult> {
    return {
      first: `CHANINFO ${channel}`,
      step: (lines, settled) => {
        if (anyLine(lines, /^The channel \S+ is not registered/i) || anyLine(lines, /^\S+ is not registered\.?$/i)) {
          return { final: { kind: 'info', info: { channel, registered: false }, lines: [...lines] } };
        }
        const head = anyLine(lines, /^(\S+) is registered by:?$/i);
        if (head) {
          if (!settled) return null;
          // Managers follow the header: "<user> - last seen: <when> ago".
          let founder: string | undefined;
          let lastUsed: string | undefined;
          for (const line of lines) {
            const m = plain(line).match(/^(\S+) - last seen:\s*(.+)$/i);
            if (m && !founder) { founder = m[1]; lastUsed = m[2]!.trim(); }
          }
          const description = anyLine(lines, /^Desc:\s*(.+)$/i)?.[1]?.trim();
          const info: ChannelRegistration = { channel: head[1]!, registered: true };
          if (founder) info.founder = founder;
          if (lastUsed) info.lastUsed = `manager seen ${lastUsed}`;
          if (description) info.description = description;
          if (anyLine(lines, /^Channel suspended/i)) info.closed = true;
          return { final: { kind: 'info', info, lines: [...lines] } };
        }
        return settled ? { final: unreadable(lines) } : null;
      },
    };
  }
}

export class QuakeNetQ implements ChanServAdapter {
  readonly id = 'q' as const;
  readonly label = 'QuakeNet Q';
  readonly serviceNick = 'Q';
  readonly caps = { info: false, ...NO_ACTIONS };

  info(): Operation<InfoResult> {
    return { first: '', step: () => ({ final: err('unsupported', []) }) };
  }
}

const GENERIC_ERRORS: readonly ErrorRule[] = [
  [/^Unknown command|^Invalid command/i, 'unsupported'],
  [/not logged in|must (?:be )?identif/i, 'not-logged-in'],
  [/^Access denied|not authori[sz]ed|permission denied/i, 'access-denied'],
];

export class GenericChanServ implements ChanServAdapter {
  readonly id = 'generic' as const;
  readonly label = 'ChanServ';
  readonly serviceNick = 'ChanServ';
  readonly caps = { info: true, ...NO_ACTIONS };

  info(channel: string): Operation<InfoResult> {
    const ch = rxEscape(channel);
    const negative = new RegExp(`${ch}\\S*\\s+(?:is not|isn't)(?: a)? registered|not a registered channel`, 'i');
    return {
      first: `INFO ${channel}`,
      step: (lines, settled) => {
        if (anyLine(lines, negative)) return { final: { kind: 'info', info: { channel, registered: false }, lines: [...lines] } };
        if (!settled) return null;
        const founder = anyLine(lines, /^\s*Founder\s*:?\s+(\S+)/i)?.[1];
        if (founder) {
          const info: ChannelRegistration = { channel, registered: true, founder: founder.replace(/[,(]$/, '') };
          const reg = anyLine(lines, /^\s*(?:Registered|Time registered)(?: at| on)?\s*:\s*(.+)$/i)?.[1]?.trim();
          if (reg) info.registeredAt = reg;
          const used = anyLine(lines, /^\s*Last (?:used|activity|opping|topic)?\s*:\s*(.+)$/i)?.[1]?.trim();
          if (used) info.lastUsed = used;
          const desc = anyLine(lines, /^\s*Description\s*:\s*(.+)$/i)?.[1]?.trim();
          if (desc) info.description = desc;
          return { final: { kind: 'info', info, lines: [...lines] } };
        }
        return { final: matchError(lines, GENERIC_ERRORS) ?? unreadable(lines) };
      },
    };
  }
}
