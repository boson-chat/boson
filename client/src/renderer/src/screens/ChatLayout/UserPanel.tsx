import { useMemo } from 'preact/hooks';
import type { ChatChannel, ChatMember } from '../../modules/chat';
import './UserPanel.css';

interface UserPanelProps {
  channel: ChatChannel | null;
}

interface MemberGroup {
  label: string;
  prefix: ChatMember['prefix'];
  members: ChatMember[];
}

// Discord-style: members grouped by role with a small header per group.
// Hover tooltip carries role + activity data; right-click context menu is the
// natural next step (whois / msg / ignore / kick).
export function UserPanel({ channel }: UserPanelProps) {
  const groups = useMemo<MemberGroup[]>(() => {
    if (!channel) return [];
    const byNick = (a: ChatMember, b: ChatMember) => a.nick.localeCompare(b.nick);
    const groupOf = (prefix: ChatMember['prefix']) =>
      channel.members.filter((m) => m.prefix === prefix).slice().sort(byNick);
    return [
      { label: 'Founders',  prefix: '~' as const, members: groupOf('~') },
      { label: 'Admins',    prefix: '&' as const, members: groupOf('&') },
      { label: 'Operators', prefix: '@' as const, members: groupOf('@') },
      { label: 'Half-ops',  prefix: '%' as const, members: groupOf('%') },
      { label: 'Voiced',    prefix: '+' as const, members: groupOf('+') },
      { label: 'Members',   prefix: ''  as const, members: groupOf('') },
    ].filter((g) => g.members.length > 0);
  }, [channel]);

  const total = channel?.members.length ?? 0;

  return (
    <aside class="user-panel" aria-label="Members">
      <div class="user-panel-header">
        <div class="user-panel-title">
          Members{total > 0 ? ` — ${total}` : ''}
        </div>
      </div>
      <div class="user-panel-list">
        {!channel && (
          <div class="user-panel-placeholder">No channel selected.</div>
        )}
        {channel && total === 0 && (
          <div class="user-panel-placeholder">
            No members yet. Waiting for the server's NAMES reply…
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} class="user-panel-group">
            <div class="user-panel-group-header">
              {g.label} — {g.members.length}
            </div>
            {g.members.map((m) => (
              <div
                key={m.nick}
                class={`user-panel-item user-panel-item-${prefixClass(m.prefix)}`}
                title={buildTooltip(m)}
              >
                <span class="user-panel-name">{m.nick}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

function prefixClass(prefix: ChatMember['prefix']): string {
  switch (prefix) {
    case '~': return 'founder';
    case '&': return 'admin';
    case '@': return 'op';
    case '%': return 'halfop';
    case '+': return 'voice';
    default:  return 'regular';
  }
}

function roleLabel(prefix: ChatMember['prefix']): string {
  switch (prefix) {
    case '~': return 'Founder';
    case '&': return 'Admin';
    case '@': return 'Operator';
    case '%': return 'Half-op';
    case '+': return 'Voiced';
    default:  return 'Member';
  }
}

// Tooltip surfaces role + any timing data we already know about. As WHO/WHOIS
// data gets plumbed through the engine we'll layer it in here too (realname,
// hostname, account, away message). Right-click context menu is a future
// enhancement.
function buildTooltip(m: ChatMember): string {
  const parts: string[] = [roleLabel(m.prefix)];
  if (m.lastActiveAt) {
    const seconds = Math.floor((Date.now() - m.lastActiveAt) / 1000);
    parts.push(`last spoke ${formatDuration(seconds)} ago`);
  } else if (m.joinedAt) {
    const seconds = Math.floor((Date.now() - m.joinedAt) / 1000);
    parts.push(`joined ${formatDuration(seconds)} ago`);
  }
  if (m.account) parts.push(`account: ${m.account}`);
  if (m.hostname) parts.push(`host: ${m.hostname}`);
  if (m.awayMessage) parts.push(`away: ${m.awayMessage}`);
  return parts.join(' · ');
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
