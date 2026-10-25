import type { ChatMember } from '../../modules/chat';
import { Avatar } from '../../shared/Avatar/Avatar';
import { BottomSheet, type SheetAction } from './BottomSheet';
import './NickSheet.css';

export function prefixClass(prefix: ChatMember['prefix']): string {
  switch (prefix) {
    case '~': return 'founder';
    case '&': return 'admin';
    case '@': return 'op';
    case '%': return 'halfop';
    case '+': return 'voice';
    default:  return 'regular';
  }
}

export function roleLabel(prefix: ChatMember['prefix']): string {
  switch (prefix) {
    case '~': return 'Founder';
    case '&': return 'Admin';
    case '@': return 'Operator';
    case '%': return 'Half-op';
    case '+': return 'Voiced';
    default:  return 'Member';
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** "Last spoke 3m ago" / "Joined 2h ago", or null when we know neither. */
export function memberActivity(member: ChatMember): string | null {
  if (member.lastActiveAt) {
    return `Last spoke ${formatDuration(Math.floor((Date.now() - member.lastActiveAt) / 1000))} ago`;
  }
  if (member.joinedAt) {
    return `Joined ${formatDuration(Math.floor((Date.now() - member.joinedAt) / 1000))} ago`;
  }
  return null;
}

export function memberMeta(member: ChatMember | null): { label: string; value: string }[] {
  const meta: { label: string; value: string }[] = [];
  if (member?.account) meta.push({ label: 'Account', value: member.account });
  if (member?.hostname) meta.push({ label: 'Host', value: member.hostname });
  if (member?.realname) meta.push({ label: 'Real name', value: member.realname });
  if (member?.awayMessage) meta.push({ label: 'Away', value: member.awayMessage });
  return meta;
}

interface NickSheetProps {
  nick: string;
  /** The channel's record for the nick; null once they've left it. */
  member: ChatMember | null;
  avatarUrl?: string;
  actions: readonly SheetAction[];
  onClose: () => void;
}

// Phone layout's stand-in for the nick hover card + right-click menu: a tap
// on a nick (member list or message author) opens who they are and what you
// can do.
export function NickSheet({ nick, member, avatarUrl, actions, onClose }: NickSheetProps) {
  const activity = member ? memberActivity(member) : null;
  const meta = memberMeta(member);
  const prefix = member?.prefix ?? '';
  return (
    <BottomSheet
      label={nick}
      actions={actions}
      onClose={onClose}
      header={
        <div class="nick-sheet-head">
          <Avatar nick={nick} url={avatarUrl} size={44} />
          <div class="nick-sheet-who">
            <span class="nick-sheet-nick">{nick}</span>
            {activity && <span class="nick-sheet-activity">{activity}</span>}
          </div>
          {member && (
            <span class={`nick-hovercard-role nick-hovercard-role-${prefixClass(prefix)}`}>
              {roleLabel(prefix)}
            </span>
          )}
        </div>
      }
    >
      {meta.length > 0 && (
        <dl class="nick-sheet-meta">
          {meta.map((row) => (
            <div key={row.label} class="nick-sheet-meta-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </BottomSheet>
  );
}
