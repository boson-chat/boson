// Shared builder for the right-click nick context menu, used by both the
// member list (UserPanel) and message authors (message-render). Keeps the
// base actions (copy / DM / mention / ignore) and the channel-operator
// section (op/voice/kick/ban/…) in one place, gated by the caller's rank.
import type { MemberPrefix } from '../../modules/chat';
import {
  prefixRank, canOp, canHalfop, canVoice, canKick, canBan,
} from '../../modules/chat';
import type { NickContextAction } from './NickContextMenu';

// Channel-operator surface for the menu. Present only inside a channel; the
// callbacks are bound to the active channel by the host (ChatLayout). kick /
// kickBan open a reason modal rather than firing immediately.
export interface ChannelOpActions {
  myRank: number;
  prefixOf: (nick: string) => MemberPrefix;
  supportsOwnerAdmin?: boolean;
  op: (nick: string, on: boolean) => void;
  halfop: (nick: string, on: boolean) => void;
  voice: (nick: string, on: boolean) => void;
  owner?: (nick: string, on: boolean) => void;
  admin?: (nick: string, on: boolean) => void;
  kick: (nick: string) => void;
  ban: (nick: string) => void;
  kickBan: (nick: string) => void;
}

export interface NickActions {
  /** Open a DM with this nick. Maps to `/msg <nick>` semantics. */
  onSendMessage?: (nick: string) => void;
  /** Insert `@nick ` at the chat input's caret. */
  onMention?: (nick: string) => void;
  /** Ignore / unignore — future use, render as danger when wired. */
  onIgnore?: (nick: string) => void;
  /** Channel-operator actions, gated by myRank. Absent outside channels. */
  ops?: ChannelOpActions;
}

const OWNER_RANK = 5;
const ADMIN_RANK = 4;

export function buildNickContextActions(nick: string, na?: NickActions): readonly NickContextAction[] {
  const out: NickContextAction[] = [
    { label: 'Copy nickname', onClick: () => { void navigator.clipboard?.writeText(nick); } },
  ];
  if (na?.onSendMessage) out.push({ label: 'Send message', onClick: () => na.onSendMessage!(nick) });
  if (na?.onMention) out.push({ label: 'Mention', onClick: () => na.onMention!(nick) });

  const ops = na?.ops;
  if (ops) {
    const cur = ops.prefixOf(nick);
    const gate = { myRank: ops.myRank, targetRank: prefixRank(cur) };
    if (canVoice(gate)) {
      const on = cur !== '+';
      out.push({ label: on ? 'Give voice (+v)' : 'Take voice (-v)', onClick: () => ops.voice(nick, on) });
    }
    if (canHalfop(gate)) {
      const on = cur !== '%';
      out.push({ label: on ? 'Give half-op (+h)' : 'Take half-op (-h)', onClick: () => ops.halfop(nick, on) });
    }
    if (canOp(gate)) {
      const on = cur !== '@';
      out.push({ label: on ? 'Give op (+o)' : 'Take op (-o)', onClick: () => ops.op(nick, on) });
    }
    if (ops.supportsOwnerAdmin && ops.admin && ops.myRank >= ADMIN_RANK) {
      const on = cur !== '&';
      out.push({ label: on ? 'Give admin (+a)' : 'Take admin (-a)', onClick: () => ops.admin!(nick, on) });
    }
    if (ops.supportsOwnerAdmin && ops.owner && ops.myRank >= OWNER_RANK) {
      const on = cur !== '~';
      out.push({ label: on ? 'Give owner (+q)' : 'Take owner (-q)', onClick: () => ops.owner!(nick, on) });
    }
    if (canKick(gate)) out.push({ label: 'Kick…', danger: true, onClick: () => ops.kick(nick) });
    if (canBan(gate)) {
      out.push({ label: 'Ban', danger: true, onClick: () => ops.ban(nick) });
      if (canKick(gate)) out.push({ label: 'Kick + Ban…', danger: true, onClick: () => ops.kickBan(nick) });
    }
  }

  if (na?.onIgnore) out.push({ label: 'Ignore', danger: true, onClick: () => na.onIgnore!(nick) });
  return out;
}
