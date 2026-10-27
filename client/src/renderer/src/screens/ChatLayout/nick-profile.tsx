import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { formatMask, type ChatMember, type WhoisInfo } from '../../modules/chat';
import { Avatar } from '../../shared/Avatar/Avatar';
import type { NickContextAction } from './NickContextMenu';
import type { NickProfiles } from './nick-actions';
import './nick-profile.css';

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

export interface ProfileRow {
  label: string;
  value: string;
  /** Shown on hover: the detail behind a short value. */
  title?: string;
}

/**
 * What we know about a nick, as label/value rows: the channel's member
 * record (from NAMES, WHO, JOIN, …) topped up by a WHOIS when there is one.
 */
export function profileRows(nick: string, member: ChatMember | null, whois?: WhoisInfo): ProfileRow[] {
  const w = whois && !whois.notFound ? whois : undefined;
  const rows: ProfileRow[] = [];
  const host = w?.host ?? member?.hostname;
  if (host) rows.push({ label: 'Mask', value: formatMask(nick, w?.user ?? member?.user, host) });
  const realname = w?.realname ?? member?.realname;
  if (realname) rows.push({ label: 'Real name', value: realname });
  const account = w?.account ?? member?.account;
  if (account) rows.push({ label: 'Account', value: account });
  // A finished WHOIS with no 330 means they aren't identified.
  else if (w && !w.loading) rows.push({ label: 'Account', value: 'Not logged in' });
  const server = w?.server ?? member?.server;
  if (server) rows.push({ label: 'Server', value: server, title: w?.serverInfo });
  if (w?.actualHost) rows.push({ label: 'Real host', value: w.actualHost });
  if (w?.secure) rows.push({ label: 'Connection', value: 'Secure (TLS)' });
  if (w?.idleSeconds !== undefined) rows.push({ label: 'Idle', value: formatDuration(w.idleSeconds) });
  if (w?.signonAt) {
    rows.push({
      label: 'Online for',
      value: formatDuration(Math.max(0, Math.floor((Date.now() - w.signonAt) / 1000))),
      title: `Connected ${new Date(w.signonAt).toLocaleString()}`,
    });
  }
  if (w?.channels?.length) rows.push({ label: 'Channels', value: w.channels.join(' ') });
  const away = w?.away ?? member?.awayMessage;
  if (away) rows.push({ label: 'Away', value: away });
  return rows;
}

/** Network-wide standing, shown as pills: IRC operator, bot. */
export function profileFlags(member: ChatMember | null, whois?: WhoisInfo): ProfileRow[] {
  const w = whois && !whois.notFound ? whois : undefined;
  const flags: ProfileRow[] = [];
  if (w?.oper || member?.oper) flags.push({ label: 'oper', value: 'IRC operator', title: w?.oper });
  if (w?.bot || member?.bot) flags.push({ label: 'bot', value: 'Bot' });
  return flags;
}

/** The nick's WHOIS, asked for once when the profile opens. */
export function useWhois(nick: string, profiles?: NickProfiles): WhoisInfo | undefined {
  useEffect(() => { profiles?.request(nick); }, [nick]);
  return profiles?.info(nick);
}

/** The body of a profile: pills, then rows, then the lookup's state. */
export function NickProfileDetails({ nick, member, whois }: {
  nick: string;
  member: ChatMember | null;
  whois?: WhoisInfo;
}) {
  const flags = profileFlags(member, whois);
  const rows = profileRows(nick, member, whois);
  return (
    <>
      {flags.length > 0 && (
        <div class="nick-profile-flags">
          {flags.map((f) => (
            <span key={f.label} class={`nick-profile-flag nick-profile-flag-${f.label}`} title={f.title}>{f.value}</span>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <dl class="nick-profile-meta">
          {rows.map((row) => (
            <div key={row.label} class="nick-profile-meta-row">
              <dt>{row.label}</dt>
              <dd title={row.title}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {whois?.loading && <div class="nick-profile-status">Looking up {nick}…</div>}
      {whois?.notFound && <div class="nick-profile-status">{nick} isn't on the network right now.</div>}
    </>
  );
}

/** Avatar, nick, last activity and channel role. */
export function NickProfileHead({ nick, member, avatarUrl, size }: {
  nick: string;
  member: ChatMember | null;
  avatarUrl?: string;
  size: number;
}) {
  const activity = member ? memberActivity(member) : null;
  return (
    <div class="nick-profile-head">
      <Avatar nick={nick} url={avatarUrl} size={size} />
      <div class="nick-profile-who">
        <span class="nick-profile-nick">{nick}</span>
        {activity && <span class="nick-profile-activity">{activity}</span>}
      </div>
      {member && (
        <span class={`nick-hovercard-role nick-hovercard-role-${prefixClass(member.prefix)}`}>
          {roleLabel(member.prefix)}
        </span>
      )}
    </div>
  );
}

export interface ProfileAnchor {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export function anchorOf(el: Element): ProfileAnchor {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
}

const CARD_WIDTH = 300;
const EDGE = 8;

/**
 * Keeps a fixed card's top inside the window once it's measured: at `top`
 * when it fits, else ending at `flipBottom` (above what it hangs off) when
 * given, else pushed up from the bottom edge.
 */
export function useFitInWindow(ref: { current: HTMLElement | null }, top: number, flipBottom?: number): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vh = window.innerHeight;
    let y = top;
    if (y + h > vh - EDGE && flipBottom !== undefined) y = flipBottom - h;
    y = Math.max(EDGE, Math.min(y, vh - h - EDGE));
    el.style.top = `${y}px`;
  });
}

interface NickProfileCardProps {
  nick: string;
  /** The channel's record for the nick; null once they've left it. */
  member: ChatMember | null;
  avatarUrl?: string;
  /** What was clicked: the card opens below it, or to its left (`side`). */
  anchor: ProfileAnchor;
  side?: 'below' | 'left';
  actions: readonly NickContextAction[];
  profiles?: NickProfiles;
  onClose: () => void;
}

// The desktop profile a click on a nick opens: who they are on the network
// (a WHOIS, fetched on open) and what you can do. Stays until a click
// outside it, Escape, or an action.
export function NickProfileCard({ nick, member, avatarUrl, anchor, side = 'below', actions, profiles, onClose }: NickProfileCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const whois = useWhois(nick, profiles);

  useLayoutEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('.nick-profile-card')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Placed after each render: the card grows as the WHOIS comes in, and
  // must stay inside the window.
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const h = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (side === 'left') {
      left = anchor.left - EDGE - CARD_WIDTH;
      if (left < EDGE) left = Math.min(anchor.right + EDGE, vw - CARD_WIDTH - EDGE);
      top = anchor.top - 4;
    } else {
      left = anchor.left;
      top = anchor.bottom + 6;
      if (top + h > vh - EDGE) top = anchor.top - 6 - h;
    }
    left = Math.max(EDGE, Math.min(left, vw - CARD_WIDTH - EDGE));
    top = Math.max(EDGE, Math.min(top, vh - h - EDGE));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  });

  return createPortal(
    <div
      ref={ref}
      class="nick-profile-card"
      role="dialog"
      aria-label={nick}
      style={`width: ${CARD_WIDTH}px; top: ${anchor.bottom + 6}px; left: ${anchor.left}px;`}
    >
      <NickProfileHead nick={nick} member={member} avatarUrl={avatarUrl} size={40} />
      <NickProfileDetails nick={nick} member={member} whois={whois} />
      {actions.length > 0 && (
        <div class="nick-profile-card-actions" role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              class={`nick-profile-card-action ${a.danger ? 'nick-profile-card-action-danger' : ''}`}
              onClick={() => { a.onClick(); onClose(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
