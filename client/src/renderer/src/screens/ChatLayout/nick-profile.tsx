import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { describeSeen, formatMask, type ChatMember, type ChatMessage, type WhoisInfo } from '../../modules/chat';
import { seenMask, type SeenRecord } from '../../modules/seen/seen.store';
import { Badge, Button, MenuItem, type BadgeTone } from '@boson/shared';
import { Avatar } from '../../shared/Avatar/Avatar';
import type { NickContextAction } from './NickContextMenu';
import { PersonMenu } from '../Friends/PersonMenu';
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

// A channel role's label colour, the same everywhere a role is shown (the
// message row's OPS, the hover card's Operator, the profile's head).
const ROLE_TONE: Record<string, BadgeTone> = {
  founder: 'danger', admin: 'warn', op: 'accent', halfop: 'mod', voice: 'success', regular: 'neutral',
};

/** A member's channel role as a Badge; `label` overrides the long name. */
export function RoleBadge({ prefix, label, class: extra }: { prefix: ChatMember['prefix']; label?: string; class?: string }) {
  const kind = prefixClass(prefix);
  return <Badge tone={ROLE_TONE[kind] ?? 'neutral'} class={extra}>{label ?? roleLabel(prefix)}</Badge>;
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
  /** Technical (IRC) detail: user@host, server, idle… Kept out of the
   *  way, under the profile's "Details". */
  detail?: boolean;
}

/** The rows a person cares about first (name, account, channels, away). */
export function primaryRows(rows: readonly ProfileRow[]): ProfileRow[] {
  return rows.filter((r) => !r.detail);
}

/**
 * What we know about a nick, as label/value rows: the channel's member
 * record (from NAMES, WHO, JOIN, …) topped up by a WHOIS when there is one.
 */
export function profileRows(nick: string, member: ChatMember | null, whois?: WhoisInfo): ProfileRow[] {
  const w = whois && !whois.notFound ? whois : undefined;
  const rows: ProfileRow[] = [];
  const host = w?.host ?? member?.hostname;
  if (host) rows.push({ label: 'Mask', value: formatMask(nick, w?.user ?? member?.user, host), detail: true });
  const realname = w?.realname ?? member?.realname;
  if (realname) rows.push({ label: 'Real name', value: realname });
  const account = w?.account ?? member?.account;
  if (account) rows.push({ label: 'Account', value: account });
  // A finished WHOIS with no 330 means they aren't identified.
  else if (w && !w.loading) rows.push({ label: 'Account', value: 'Not logged in' });
  const server = w?.server ?? member?.server;
  if (server) rows.push({ label: 'Server', value: server, title: w?.serverInfo, detail: true });
  if (w?.actualHost) rows.push({ label: 'Real host', value: w.actualHost, detail: true });
  if (w?.secure) rows.push({ label: 'Connection', value: 'Secure (TLS)', detail: true });
  if (w?.idleSeconds !== undefined) rows.push({ label: 'Idle', value: formatDuration(w.idleSeconds), detail: true });
  if (w?.signonAt) {
    rows.push({
      label: 'Online for',
      value: formatDuration(Math.max(0, Math.floor((Date.now() - w.signonAt) / 1000))),
      title: `Connected ${new Date(w.signonAt).toLocaleString()}`,
      detail: true,
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

/**
 * Who the nick was on one activity line (join/part/quit/kick), as recorded
 * then: the host at that moment, which may differ from now.
 */
export interface LineIdentity {
  user?: string;
  host?: string;
  account?: string;
  realname?: string;
  at: number;
  kind: ChatMessage['kind'];
}

/** The identity a message recorded for its sender, when it has one. */
export function lineIdentityOf(msg: ChatMessage): LineIdentity | undefined {
  if (!msg.host) return undefined;
  return { user: msg.user, host: msg.host, account: msg.account, realname: msg.realname, at: msg.timestamp, kind: msg.kind };
}

/** Whether we have the nick's identity live (member list or a WHOIS). */
export function hasLiveIdentity(member: ChatMember | null, whois?: WhoisInfo): boolean {
  return !!member?.hostname || !!(whois && !whois.notFound && whois.host);
}

/** Rows for a remembered record (seen store). */
export function rememberedRows(seen: SeenRecord, skipMask?: string | null): ProfileRow[] {
  const rows: ProfileRow[] = [];
  const mask = seenMask(seen);
  if (mask && mask !== skipMask) rows.push({ label: 'Host', value: mask });
  if (seen.actualHost) rows.push({ label: 'Real host', value: seen.actualHost });
  if (seen.account) rows.push({ label: 'Account', value: seen.account });
  if (seen.realname) rows.push({ label: 'Real name', value: seen.realname });
  if (seen.prevHosts?.length) rows.push({ label: 'Earlier', value: seen.prevHosts.join(' ') });
  return rows;
}

function lineVerb(kind: ChatMessage['kind']): string {
  switch (kind) {
    case 'join': return 'When they joined';
    case 'part': return 'When they left';
    case 'quit': return 'When they quit';
    case 'kick': return 'When they kicked';
    default: return 'On this line';
  }
}

function CopyButton({ text }: { text: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      class="nick-profile-copy"
      title="Copy"
      aria-label={`Copy ${text}`}
      onClick={() => { void navigator.clipboard?.writeText(text); }}
    >
      Copy
    </Button>
  );
}

/**
 * The host recorded on an activity line, and what Boson remembers of a
 * nick that has left (when there's nothing live to show). `copyable` adds
 * a copy button to hosts (not in the hover tooltip, which can't be clicked).
 */
export function RememberedDetails({ nick, member, whois, seen, line, copyable = true }: {
  nick: string;
  member: ChatMember | null;
  whois?: WhoisInfo;
  seen?: SeenRecord;
  line?: LineIdentity;
  copyable?: boolean;
}) {
  const lineMask = line ? seenMask(line) : null;
  const showSeen = !!seen && !hasLiveIdentity(member, whois);
  const seenRows = showSeen ? rememberedRows(seen!, lineMask) : [];
  if (!lineMask && !showSeen) return null;
  const row = (r: ProfileRow) => (
    <div key={r.label} class="nick-profile-meta-row">
      <dt>{r.label}</dt>
      <dd title={r.title}>
        <span class="nick-profile-selectable">{r.value}</span>
        {copyable && (r.label === 'Host' || r.label === 'Real host') && <CopyButton text={r.value} />}
      </dd>
    </div>
  );
  return (
    <>
      {lineMask && line && (
        <div class="nick-profile-remembered" data-testid="nick-profile-line">
          <div class="nick-profile-remembered-head">
            {lineVerb(line.kind)} · {new Date(line.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
          </div>
          <dl class="nick-profile-meta nick-profile-meta-tight">
            {row({ label: 'Host', value: lineMask })}
            {line.account && row({ label: 'Account', value: line.account })}
            {line.realname && row({ label: 'Real name', value: line.realname })}
          </dl>
        </div>
      )}
      {showSeen && (
        <div class="nick-profile-remembered" data-testid="nick-profile-remembered">
          <div class="nick-profile-remembered-head" title="Kept on this device only">
            Remembered · last seen {describeSeen(seen!)}
          </div>
          {seenRows.length > 0 && <dl class="nick-profile-meta nick-profile-meta-tight">{seenRows.map(row)}</dl>}
          {seen!.nick !== nick && <div class="nick-profile-status">as {seen!.nick}</div>}
        </div>
      )}
    </>
  );
}

/** Whether RememberedDetails has anything to show. */
function hasRemembered(member: ChatMember | null, whois?: WhoisInfo, seen?: SeenRecord, line?: LineIdentity): boolean {
  return (!!line && !!seenMask(line)) || (!!seen && !hasLiveIdentity(member, whois));
}

/** The nick's WHOIS, asked for once when the profile opens. */
export function useWhois(nick: string, profiles?: NickProfiles): WhoisInfo | undefined {
  useEffect(() => { profiles?.request(nick); }, [nick]);
  return profiles?.info(nick);
}

/** The body of a profile: pills, then rows, then the lookup's state. */
export function NickProfileDetails({ nick, member, whois, seen, line }: {
  nick: string;
  member: ChatMember | null;
  whois?: WhoisInfo;
  /** What we remember of them, shown when nothing live is known. */
  seen?: SeenRecord;
  /** The identity on the activity line that was clicked. */
  line?: LineIdentity;
}) {
  const flags = profileFlags(member, whois);
  const all = profileRows(nick, member, whois);
  const rows = primaryRows(all);
  const details = all.filter((r) => r.detail);
  const row = (r: ProfileRow) => (
    <div key={r.label} class="nick-profile-meta-row">
      <dt>{r.label}</dt>
      <dd title={r.title}>{r.value}</dd>
    </div>
  );
  return (
    <>
      {flags.length > 0 && (
        <div class="nick-profile-flags">
          {flags.map((f) => (
            <Badge key={f.label} tone={f.label === 'oper' ? 'warn' : f.label === 'bot' ? 'info' : 'neutral'} class={`nick-profile-flag nick-profile-flag-${f.label}`} title={f.title}>{f.value}</Badge>
          ))}
        </div>
      )}
      {rows.length > 0 && <dl class="nick-profile-meta">{rows.map(row)}</dl>}
      {/* The IRC side of them (user@host, server, idle…), and what Boson
          remembers of their hosts: there when you want it, not up front. */}
      {(details.length > 0 || hasRemembered(member, whois, seen, line)) && (
        <details class="nick-profile-details" open={!!line || (!!whois?.notFound && !!seen)}>
          <summary class="nick-profile-details-summary">Details</summary>
          {details.length > 0 && <dl class="nick-profile-meta">{details.map(row)}</dl>}
          <RememberedDetails nick={nick} member={member} whois={whois} seen={seen} line={line} />
        </details>
      )}
      {whois?.loading && <div class="nick-profile-status">Looking up {nick}…</div>}
      {whois?.notFound && <div class="nick-profile-status">{nick} isn't on the network right now.</div>}
    </>
  );
}

/** Avatar, nick, last activity and channel role. */
export function NickProfileHead({ nick, member, avatarUrl, size, home }: {
  nick: string;
  member: ChatMember | null;
  avatarUrl?: string;
  size: number;
  /** A federated user's home domain (shown as a small @domain). */
  home?: string;
}) {
  const activity = member ? memberActivity(member) : null;
  return (
    <div class="nick-profile-head">
      <Avatar nick={nick} url={avatarUrl} size={size} />
      <div class="nick-profile-who">
        <span class="nick-profile-nick">
          {nick}
          {home && <span class="nick-profile-home" title={`Signed in with an account from ${home}`}>@{home}</span>}
        </span>
        {activity && <span class="nick-profile-activity">{activity}</span>}
      </div>
      {member && (
        <RoleBadge prefix={member.prefix} class={`nick-hovercard-role nick-hovercard-role-${prefixClass(member.prefix)}`} />
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
  /** The activity line clicked, when it was one. */
  line?: LineIdentity;
  onClose: () => void;
}

// The desktop profile a click on a nick opens: who they are on the network
// (a WHOIS, fetched on open) and what you can do. Stays until a click
// outside it, Escape, or an action.
export function NickProfileCard({ nick, member, avatarUrl, anchor, side = 'below', actions, profiles, line, onClose }: NickProfileCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const whois = useWhois(nick, profiles);
  const seen = profiles?.seen?.(nick);

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
      <NickProfileHead nick={nick} member={member} avatarUrl={avatarUrl} size={40} home={profiles?.home?.(nick, member?.account ?? whois?.account)} />
      <NickProfileDetails nick={nick} member={member} whois={whois} seen={seen} line={line} />
      <div class="nick-profile-card-person"><PersonMenu nick={nick} account={member?.account ?? whois?.account} variant="menu" onDone={onClose} /></div>
      {actions.length > 0 && (
        <div class="nick-profile-card-actions" role="menu">
          {actions.map((a) => (
            <MenuItem
              key={a.label}
              danger={a.danger}
              class="nick-profile-card-action"
              onClick={() => { a.onClick(); onClose(); }}
            >
              {a.label}
            </MenuItem>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
