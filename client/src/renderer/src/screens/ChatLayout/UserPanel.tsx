import { useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { AtomLoader } from '@boson/shared';
import type { ChatChannel, ChatMember } from '../../modules/chat';
import { Avatar } from '../../shared/Avatar/Avatar';
import { NickContextMenu, type NickContextAction } from './NickContextMenu';
import './UserPanel.css';

export interface NickActions {
  /** Open a DM with this nick. Maps to `/msg <nick>` semantics. */
  onSendMessage?: (nick: string) => void;
  /** Insert `@nick ` at the chat input's caret. */
  onMention?: (nick: string) => void;
  /** Ignore / unignore — future use, render as danger when wired. */
  onIgnore?: (nick: string) => void;
}

interface UserPanelProps {
  channel: ChatChannel | null;
  /** Optional callbacks the right-click context menu binds to. When all
   *  are absent the menu is suppressed (right-click falls back to native
   *  browser behaviour). */
  nickActions?: NickActions;
  /** Resolve a nick to its profile-image URL (Boson members). Returns
   *  undefined for non-members → the nick-colored initial fallback. */
  avatarFor?: (nick: string) => string | undefined;
}

interface MemberGroup {
  label: string;
  prefix: ChatMember['prefix'];
  members: ChatMember[];
}

// Coordinates captured from mouseenter on a member row so the portal-
// rendered hover card can sit next to that exact row. We hold a snapshot
// of the row's bounding rect rather than a DOM ref so React/Preact owns
// the lifecycle and we don't need to re-measure on every render.
interface HoverState {
  member: ChatMember;
  rowTop: number;     // viewport-relative top of the hovered row
  rowLeft: number;    // viewport-relative left of the hovered row
}

// Discord-style: members grouped by role with a small header per group.
// Hover tooltip carries role + activity data. Right-click context menu
// (whois / PM / ignore) is wired separately when onContextNick is set.
// Open-delay for the hover card. Short enough that an intentional
// hover lands instantly to the eye, long enough that a mouse just
// passing through a row doesn't flash a card.
const HOVER_OPEN_DELAY_MS = 150;

export function UserPanel({ channel, nickActions, avatarFor }: UserPanelProps) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const [menu, setMenu] = useState<{ nick: string; x: number; y: number } | null>(null);
  // Debounce the hover-card open: we capture the row's bounding box on
  // mouseenter (which has to happen synchronously while the event still
  // owns the element) but defer flipping the state until the cursor has
  // dwelled for HOVER_OPEN_DELAY_MS. mouseleave clears the timer so
  // moving through rows doesn't flash a card.
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingOpen = () => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  function buildActions(nick: string): readonly NickContextAction[] {
    const out: NickContextAction[] = [
      {
        label: 'Copy nickname',
        onClick: () => { void navigator.clipboard?.writeText(nick); },
      },
    ];
    if (nickActions?.onSendMessage) {
      out.push({ label: 'Send message', onClick: () => nickActions.onSendMessage!(nick) });
    }
    if (nickActions?.onMention) {
      out.push({ label: 'Mention', onClick: () => nickActions.onMention!(nick) });
    }
    if (nickActions?.onIgnore) {
      out.push({ label: 'Ignore', danger: true, onClick: () => nickActions.onIgnore!(nick) });
    }
    return out;
  }

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
          <div class="user-panel-loading">
            <AtomLoader size={26} label="Loading members" />
            <span>Loading members…</span>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} class="user-panel-group">
            <div class="user-panel-group-header">
              {g.label} — {g.members.length}
            </div>
            {g.members.map((m) => {
              const presence = m.awayMessage ? 'away' : 'online';
              return (
                <div
                  key={m.nick}
                  class={`user-panel-item user-panel-item-${prefixClass(m.prefix)} user-panel-item-${presence}`}
                  onMouseEnter={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const snapshot: HoverState = { member: m, rowTop: r.top, rowLeft: r.left };
                    cancelPendingOpen();
                    openTimer.current = setTimeout(() => {
                      setHover(snapshot);
                      openTimer.current = null;
                    }, HOVER_OPEN_DELAY_MS);
                  }}
                  onMouseLeave={() => {
                    cancelPendingOpen();
                    setHover((prev) => (prev && prev.member.nick === m.nick ? null : prev));
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ nick: m.nick, x: e.clientX, y: e.clientY });
                  }}
                >
                  <Avatar nick={m.nick} url={avatarFor?.(m.nick)} size={22} />
                  <span class="user-panel-name">{m.nick}</span>
                  <span
                    class={`user-panel-presence user-panel-presence-${presence}`}
                    aria-label={presence === 'away' ? 'Away' : 'Online'}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {hover && createPortal(
        <NickHoverCard
          member={hover.member}
          rowTop={hover.rowTop}
          rowLeft={hover.rowLeft}
        />,
        document.body,
      )}
      {menu && (
        <NickContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.nick}
          actions={buildActions(menu.nick)}
          onClose={() => setMenu(null)}
        />
      )}
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

// Hover card rendered via portal at document.body so it can extend
// outside the UserPanel's scroll container without being clipped.
// Position is fixed (viewport-relative) — `rowTop` / `rowLeft` come
// from the hovered member row's getBoundingClientRect captured on
// mouseenter. Card is anchored to the LEFT of the row.
function NickHoverCard({ member, rowTop, rowLeft }: {
  member: ChatMember;
  rowTop: number;
  rowLeft: number;
}) {
  const meta: { label: string; value: string }[] = [];
  if (member.account) meta.push({ label: 'Account', value: member.account });
  if (member.hostname) meta.push({ label: 'Host', value: member.hostname });
  if (member.realname) meta.push({ label: 'Real name', value: member.realname });
  if (member.awayMessage) meta.push({ label: 'Away', value: member.awayMessage });
  let activity: string | null = null;
  if (member.lastActiveAt) {
    activity = `Last spoke ${formatDuration(Math.floor((Date.now() - member.lastActiveAt) / 1000))} ago`;
  } else if (member.joinedAt) {
    activity = `Joined ${formatDuration(Math.floor((Date.now() - member.joinedAt) / 1000))} ago`;
  }
  // Position: card's RIGHT edge sits 8px to the left of the hovered row,
  // vertically aligned at the row's top. Clamp to viewport so we don't
  // overflow off the top edge on a row near y=0.
  const CARD_WIDTH = 240;
  const right = Math.max(8, window.innerWidth - rowLeft + 8);
  const top = Math.max(8, rowTop - 4);
  return (
    <div
      class="nick-hovercard nick-hovercard-portal"
      role="tooltip"
      style={`top: ${top}px; right: ${right}px; width: ${CARD_WIDTH}px;`}
    >
      <div class="nick-hovercard-head">
        <span class="nick-hovercard-nick">{member.nick}</span>
        <span class={`nick-hovercard-role nick-hovercard-role-${prefixClass(member.prefix)}`}>
          {roleLabel(member.prefix)}
        </span>
      </div>
      {activity && <div class="nick-hovercard-activity">{activity}</div>}
      {meta.length > 0 && (
        <dl class="nick-hovercard-meta">
          {meta.map((row) => (
            <div key={row.label} class="nick-hovercard-meta-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
