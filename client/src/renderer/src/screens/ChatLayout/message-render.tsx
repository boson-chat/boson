import type preact from 'preact';
import type { Ref } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal, memo } from 'preact/compat';
import type { Signal } from '@preact/signals';
import type { ChatMember, ChatMessage, MemberPrefix } from '../../modules/chat';
import { BarLoader, Button, Menu, MenuItem } from '@boson/shared';
import { Copy, CornerUpLeft, UserRound } from 'lucide-preact';
import { Avatar } from '../../shared/Avatar/Avatar';
import { tokenizeMarkdown, isPreformattedLine, stripIrcFormatting, type MdToken } from './markdown';
import { parseTables, type ParsedTable } from './table';
import { parseBanners, splitBannerLine, type Banner } from './banner';
import { BURST_GAP_MS, hasBlockMarkdown, isMarkdownDocument } from './markdown-blocks';
import { MarkdownDoc } from './MarkdownDoc';
import { emojiFor } from './emoji-data';
import { MessageEmbeds } from './Embed';
import { NICK_BOUNDARY_CHARS } from './chat-input.tokenize';
import { NickContextMenu } from './NickContextMenu';
import { NickSheet } from './NickSheet';
import {
  NickProfileCard, RememberedDetails, RoleBadge, anchorOf, lineIdentityOf, primaryRows, profileRows, useFitInWindow,
  type LineIdentity, type ProfileAnchor,
} from './nick-profile';
import type { SeenRecord } from '../../modules/seen/seen.store';
import { seenMask } from '../../modules/seen/seen.store';
import { privacySettings } from '../../modules/ui/privacy.store';
import { getChatDisplaySettings, onChatDisplaySettingsChange } from '../../modules/ui/chat-display.store';
import { replyBody, withoutReplyPrefix } from '../../modules/chat/replies';
import { MessageSheet } from './MessageSheet';
import { DeletedText, useMessageExtras } from './reactions';
import type { SheetAction } from './BottomSheet';
import { useLongPress } from './long-press';
import { isNarrow } from '../../shared/narrow';
import { buildNickContextActions, type NickActions } from './nick-actions';
import { AT_BOTTOM_SLACK } from './scroll-resolve';
import {
  bottomOf, captureAnchor, HeightCache, Layout, locateAnchor, placeAnchored, restoreAnchor, userAtBottom, type Anchor,
} from './virtual-list';

// Map IRC channel-status prefix to a short display label + a class name.
// Used both for the role pill rendered next to a nick in chat (MOD/OPS/V)
// and for color theming in the hover card. Centralised here so message
// rows and the member panel can't drift apart on label/color.
const ROLE_BADGES: Record<MemberPrefix, { label: string; kind: string; prefix: MemberPrefix } | null> = {
  '~': { label: 'FOUNDER', kind: 'founder', prefix: '~' },
  '&': { label: 'ADMIN',   kind: 'admin', prefix: '&' },
  '@': { label: 'OPS',     kind: 'op', prefix: '@' },
  '%': { label: 'MOD',     kind: 'halfop', prefix: '%' },
  '+': { label: 'V',       kind: 'voice', prefix: '+' },
  '':  null,
};

function findMemberPrefix(members: { nick: string; prefix?: MemberPrefix }[], nick: string): MemberPrefix {
  return members.find((m) => m.nick === nick)?.prefix ?? '';
}

interface MessageRowProps {
  msg: ChatMessage;
  myNick: string;
  members: ChatMember[];
  grouped?: boolean;
  /** Action callbacks bound to the right-click nick context menu. */
  nickActions?: NickActions;
  /** True when this message has arrived in real-time *since* this view's
   *  freshness baseline. Drives the slide-in entrance animation. */
  fresh?: boolean;
  /** Resolve a nick to its profile-image URL (Boson members). */
  avatarFor?: (nick: string) => string | undefined;
  /** msg.text is a multi-line markdown document (a paste), not one line. */
  doc?: boolean;
  /** A reply (msg.replyTo / msg.replyToId): the message it answers, null
   *  when that one can't be had, 'loading' while it's being fetched.
   *  Undefined for a message that isn't a reply. */
  replyParent?: ChatMessage | null | 'loading';
  /** Scroll the conversation to a message (the quote's click). */
  onJumpTo?: (target: ChatMessage) => void;
}

// Match UserPanel's hover-card open-delay so dwelling on a nick in chat
// and dwelling on one in the right rail feel identically responsive.
const HOVER_OPEN_DELAY_MS = 150;

// Memoised: the windowed list re-renders as it scrolls; rows whose props
// didn't change don't.
export const MessageRow = memo(function MessageRow({ msg, myNick, members, grouped = false, nickActions, fresh = false, avatarFor, doc = false, replyParent, onJumpTo }: MessageRowProps) {
  const [menu, setMenu] = useState<{ nick: string; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ nick: string; top: number; left: number } | null>(null);
  // A click on a nick (the author, or one mentioned in the text) opens their
  // profile: a card under it, or on a phone the nick sheet. A long press on
  // the message opens the message sheet in place of a text selection.
  const [profile, setProfile] = useState<{ nick: string; anchor?: ProfileAnchor } | null>(null);
  const [msgSheet, setMsgSheet] = useState(false);
  const longPress = useLongPress(isNarrow)(() => setMsgSheet(true));
  // Debounce-on-enter timer for the hover card — see `UserPanel.tsx`.
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingOpen = () => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  const openProfile = (nick: string, el: Element): void => {
    if (isNarrow()) { setProfile({ nick }); return; }
    cancelPendingOpen();
    setHover(null);
    setProfile({ nick, anchor: anchorOf(el) });
  };
  // Mentions in the text carry their nick (see renderRichText).
  const onTextClick = (e: MouseEvent): void => {
    const mention = (e.target as Element | null)?.closest?.('.chat-token-mention[data-nick]');
    if (mention) openProfile(mention.getAttribute('data-nick')!, mention);
  };
  const profileMember = profile ? members.find((m) => m.nick === profile.nick) ?? null : null;

  // The message's actions: the phone's long-press sheet, and on a desktop
  // the hover toolbar and the right-click menu (the same list). On a
  // desktop "View profile" opens the card by the author's name.
  const rowRef = useRef<HTMLDivElement>(null);
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number } | null>(null);
  const theirs = msg.from !== myNick;
  // Reactions and Delete (reactions.tsx).
  const extras = useMessageExtras(msg, myNick, nickActions?.message);
  // Anyone else's line (the reply's text says which, msgid or not); your
  // own once the server has given it a msgid (echo-message).
  const reply = msg.pending || msg.redacted || (!theirs && !msg.msgid) ? undefined
    : nickActions?.onReply ? () => nickActions.onReply!(msg)
      : nickActions?.onMention ? () => nickActions.onMention!(msg.from) : undefined;
  const copyText = (): void => { void navigator.clipboard?.writeText(stripIrcFormatting(msg.text)); };
  const viewProfile = (): void => {
    const el = !isNarrow() && rowRef.current?.querySelector('.message-row-name, .message-action-name, .message-avatar-btn');
    if (el) openProfile(msg.from, el); else setProfile({ nick: msg.from });
  };
  const messageActions = (at?: { x: number; y: number }): SheetAction[] => {
    const out: SheetAction[] = [];
    if (reply) out.push({ label: 'Reply', onClick: reply });
    out.push(...extras.menuActions(at).filter((a) => !a.danger));
    if (!msg.redacted) out.push({ label: 'Copy text', onClick: copyText });
    if (theirs && nickActions?.onSendMessage) {
      out.push({ label: `Message ${msg.from}`, onClick: () => nickActions.onSendMessage!(msg.from) });
    }
    out.push({ label: 'View profile', onClick: viewProfile });
    out.push(...extras.menuActions(at).filter((a) => a.danger));
    return out;
  };
  // Right-click anywhere on the message (but a nick, a link or selected
  // text, which keep their own menus).
  const onRowContextMenu = (e: MouseEvent): void => {
    // Phones: a long press opens the sheet instead (useLongPress).
    if (isNarrow()) { longPress.onContextMenu(e); return; }
    const t = e.target as Element | null;
    if (t?.closest?.('a, .message-row-name, .sys-nick, .chat-token-mention, .embed, input, textarea')) return;
    if (window.getSelection?.()?.toString()) return;
    e.preventDefault();
    setMenu(null);
    setMsgMenu({ x: e.clientX, y: e.clientY });
  };
  const toolbar = (
    <div class="message-toolbar" role="toolbar" aria-label="Message actions">
      {reply && (
        <Button variant="ghost" size="sm" class="message-toolbar-btn" onClick={reply}
          title="Reply" aria-label="Reply" icon={<CornerUpLeft aria-hidden="true" />} />
      )}
      {extras.toolbarButtons}
      <Button variant="ghost" size="sm" class="message-toolbar-btn" onClick={copyText}
        title="Copy text" aria-label="Copy text" icon={<Copy aria-hidden="true" />} />
      <Button variant="ghost" size="sm" class="message-toolbar-btn" onClick={viewProfile}
        title="View profile" aria-label="View profile" icon={<UserRound aria-hidden="true" />} />
    </div>
  );
  const sheets = (
    <>
      {msgMenu && createPortal(
        <Menu
          label="Message actions"
          x={Math.min(msgMenu.x, window.innerWidth - 200)}
          y={Math.max(8, Math.min(msgMenu.y, window.innerHeight - 180))}
          onClose={() => setMsgMenu(null)}
          class="message-context-menu"
        >
          {messageActions(msgMenu).map((a) => (
            <MenuItem key={a.label} danger={a.danger} onClick={() => { setMsgMenu(null); a.onClick(); }}>{a.label}</MenuItem>
          ))}
        </Menu>,
        document.body,
      )}
      {msgSheet && (
        <MessageSheet
          msg={msg}
          avatarUrl={avatarFor?.(msg.from)}
          actions={messageActions()}
          onClose={() => setMsgSheet(false)}
        />
      )}
      {extras.overlays}
      {profile && !profile.anchor && (
        <NickSheet
          nick={profile.nick}
          member={profileMember}
          avatarUrl={avatarFor?.(profile.nick)}
          actions={buildNickContextActions(profile.nick, nickActions)}
          profiles={nickActions?.profiles}
          onClose={() => setProfile(null)}
        />
      )}
      {profile?.anchor && (
        <NickProfileCard
          nick={profile.nick}
          member={profileMember}
          avatarUrl={avatarFor?.(profile.nick)}
          anchor={profile.anchor}
          actions={buildNickContextActions(profile.nick, nickActions)}
          profiles={nickActions?.profiles}
          onClose={() => setProfile(null)}
        />
      )}
    </>
  );

  if (msg.kind === 'join' || msg.kind === 'part' || msg.kind === 'quit') {
    return <ActivityLine msg={msg} members={members} nickActions={nickActions} avatarFor={avatarFor} fresh={fresh} />;
  }
  if (msg.kind === 'system') {
    return (
      <div class={`message-system message-system-${msg.kind} ${fresh ? 'message-fresh' : ''}`}>
        <span class="sys-text">{msg.text}</span>
      </div>
    );
  }

  const mine = msg.from === myNick;
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Only flag the row as a mention when someone *else* says our nick. Our
  // own messages always contain our nick (in `from`) but never count.
  // A reply to one of our lines is a mention too.
  const parent = replyParent && replyParent !== 'loading' ? replyParent : null;
  const mentionsMe = !mine && (containsNickMention(msg.text, myNick) || (!!parent && parent.from.toLowerCase() === myNick.toLowerCase()));
  // A reply's text without the `nick: "quote..." ` its quote stands for.
  const body = replyBody(msg, parent);
  const renderedText = doc ? null : msg.redacted ? <DeletedText /> : renderMessageBody(body, myNick, members);
  const quote = replyParent !== undefined && <ReplyQuote parent={replyParent} guessed={!!msg.replyGuess} onJumpTo={onJumpTo} />;

  if (msg.kind === 'action') {
    return (
      <div ref={rowRef} class={`message-action ${mine ? 'message-action-mine' : ''} ${mentionsMe ? 'message-action-mention' : ''} ${fresh ? 'message-fresh' : ''}`} {...longPress} onContextMenu={onRowContextMenu}>
        {quote}
        <span class="message-action-star">*</span>
        <span class="message-action-name" onClick={(e) => openProfile(msg.from, e.currentTarget as Element)}>{msg.from}</span>
        <span class="message-action-text" onClick={onTextClick}>{renderedText}</span>
        <span class="message-row-time">{time}</span>
        {extras.chips}
        {sheets}
      </div>
    );
  }

  const classes = [
    'message-row',
    mine ? 'message-row-mine' : '',
    msg.kind === 'notice' ? 'message-row-notice' : '',
    mentionsMe ? 'message-row-mention' : '',
    grouped ? 'message-row-grouped' : '',
    fresh ? 'message-fresh' : '',
    msg.pending ? 'message-row-pending' : '',
  ].filter(Boolean).join(' ');

  const badge = ROLE_BADGES[findMemberPrefix(members, msg.from)];

  return (
    <div ref={rowRef} class={classes} {...longPress} onContextMenu={onRowContextMenu}>
      {!msg.pending && !msg.redacted && toolbar}
      {/* Avatar gutter — the initial tile leads the first message of a group;
          grouped follow-ups keep the gutter empty so text stays aligned. */}
      <div class="message-row-gutter">
        {!grouped && (
          <span class="message-avatar-btn" onClick={(e) => openProfile(msg.from, e.currentTarget as Element)}>
            <Avatar nick={msg.from} url={avatarFor?.(msg.from)} size={30} class="message-avatar" />
          </span>
        )}
      </div>
      <div class="message-row-body">
        {quote}
        {!grouped && (
          <div class="message-row-header">
            <span
              class="message-row-name"
              onContextMenu={(e) => {
                e.preventDefault();
                if (isNarrow()) return;
                setMenu({ nick: msg.from, x: e.clientX, y: e.clientY });
              }}
              onClick={(e) => openProfile(msg.from, e.currentTarget as Element)}
              onMouseEnter={(e) => {
                // A tap on a phone emulates mouseenter; the sheet covers it.
                // An open profile card covers it too.
                if (isNarrow() || profile) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const snapshot = { nick: msg.from, top: r.top, left: r.left };
                cancelPendingOpen();
                openTimer.current = setTimeout(() => {
                  setHover(snapshot);
                  openTimer.current = null;
                }, HOVER_OPEN_DELAY_MS);
              }}
              onMouseLeave={() => {
                cancelPendingOpen();
                setHover((prev) => (prev && prev.nick === msg.from ? null : prev));
              }}
            >
              {msg.from}
            </span>
            {badge && (
              <RoleBadge prefix={badge.prefix} label={badge.label} class={`message-row-role message-row-role-${badge.kind}`} />
            )}
            <span class="message-row-time">{msg.pending ? 'Sending…' : time}</span>
          </div>
        )}
        <div class={`message-row-text${doc ? ' message-row-doc' : ''}`} onClick={onTextClick}>
          {doc
            ? <MarkdownDoc text={body} />
            : <span class="message-row-text-body">{renderedText}</span>}
          {grouped && <span class="message-row-grouped-time" aria-hidden={!msg.pending}>{msg.pending ? 'Sending…' : time}</span>}
        </div>
        {!doc && <MessageEmbeds text={msg.text} />}
        {extras.chips}
      </div>
      {menu && (
        <NickContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.nick}
          actions={buildNickContextActions(menu.nick, nickActions)}
          onClose={() => setMenu(null)}
        />
      )}
      {sheets}
      {hover && createPortal(
        <MessageNickHoverCard
          nick={hover.nick}
          member={members.find((m) => m.nick === hover.nick) ?? null}
          seen={nickActions?.profiles?.seen?.(hover.nick)}
          top={hover.top}
          left={hover.left}
        />,
        document.body,
      )}
    </div>
  );
});

// What a quoted message says: a reply's own text, without the
// `nick: "quote..." ` it starts with.
function quoteText(m: ChatMessage): string {
  return m.replyTo || (m.replyToId && !m.replyGuess) ? withoutReplyPrefix(m.text) : m.text;
}

// One line of a message, for a quote: formatting stripped, whitespace
// folded (the CSS ellipsizes it).
export function excerptOf(text: string): string {
  return stripIrcFormatting(text).replace(/\s+/g, ' ').trim();
}

// Above a reply: who it answers and the start of what they said; a click
// scrolls to it (loading older messages until it's there). When that
// message can't be had (the server keeps no history, or not that far) it
// says so instead. A guessed reply (the text only said `nick:`) is fainter.
export function ReplyQuote({ parent, guessed = false, onJumpTo }: {
  parent: ChatMessage | null | 'loading';
  guessed?: boolean;
  onJumpTo?: (target: ChatMessage) => void;
}) {
  if (!parent || parent === 'loading') {
    return (
      <div class={`message-reply-quote message-reply-quote-missing${parent ? ' message-reply-quote-loading' : ''}`}>
        <CornerUpLeft aria-hidden="true" class="message-reply-quote-icon" />
        <span class="message-reply-quote-text">{parent ? 'Loading original message…' : 'Original message not available'}</span>
      </div>
    );
  }
  const text = parent.kind === 'action' ? `* ${parent.from} ${excerptOf(parent.text)}` : excerptOf(quoteText(parent));
  return (
    <button
      type="button"
      class={`message-reply-quote${guessed ? ' message-reply-quote-guessed' : ''}`}
      onClick={(e) => { e.stopPropagation(); onJumpTo?.(parent); }}
      title={guessed ? 'Probably a reply to this. Show the original message' : 'Show the original message'}
      aria-label={`${guessed ? 'Probably a reply' : 'Reply'} to ${parent.from}: ${text}. Show the original message`}
    >
      <CornerUpLeft aria-hidden="true" class="message-reply-quote-icon" />
      <span class="message-reply-quote-author">{parent.from}</span>
      <span class="message-reply-quote-text">{text}</span>
    </button>
  );
}

interface ActivityLineProps {
  msg: ChatMessage;
  members: ChatMember[];
  nickActions?: NickActions;
  avatarFor?: (nick: string) => string | undefined;
  fresh?: boolean;
  /** Times the same line repeated (folded groups). */
  count?: number;
  extraClass?: string;
}

// A join / part / quit line. The nick opens their profile on click and a
// hover card on hover, both showing the host recorded on this line (who
// they were at that moment), plus what Boson remembers once they're gone.
// With "Show hosts in join/part lines" on, the host follows the nick.
export function ActivityLine({ msg, members, nickActions, avatarFor, fresh = false, count = 1, extraClass = '' }: ActivityLineProps) {
  const [profile, setProfile] = useState<{ anchor?: ProfileAnchor } | null>(null);
  const [hover, setHover] = useState<{ top: number; left: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingOpen = (): void => {
    if (openTimer.current !== null) { clearTimeout(openTimer.current); openTimer.current = null; }
  };
  useEffect(() => cancelPendingOpen, []);
  const prefs = privacySettings.value;
  const nick = msg.from;
  const line = prefs.rememberHosts ? lineIdentityOf(msg) : undefined;
  const mask = line ? seenMask(line) : null;
  const splitAt = nick && msg.text.startsWith(nick) ? nick.length : -1;
  const suffix = count > 1 ? ` ×${count}` : '';
  if (splitAt < 0) {
    return (
      <div class={`message-system message-system-${msg.kind} ${extraClass} ${fresh ? 'message-fresh' : ''}`}>
        <span class="sys-text">{msg.text}{suffix}</span>
      </div>
    );
  }
  const member = members.find((m) => m.nick === nick) ?? null;
  return (
    <div class={`message-system message-system-${msg.kind} ${extraClass} ${fresh ? 'message-fresh' : ''}`}>
      <span class="sys-text">
        <span
          class="sys-nick"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            cancelPendingOpen();
            setHover(null);
            setProfile(isNarrow() ? {} : { anchor: anchorOf(e.currentTarget as Element) });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setProfile(isNarrow() ? {} : { anchor: anchorOf(e.currentTarget as Element) });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (isNarrow()) return;
            setMenu({ x: e.clientX, y: e.clientY });
          }}
          onMouseEnter={(e) => {
            if (isNarrow() || profile) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const snapshot = { top: r.top, left: r.left };
            cancelPendingOpen();
            openTimer.current = setTimeout(() => { setHover(snapshot); openTimer.current = null; }, HOVER_OPEN_DELAY_MS);
          }}
          onMouseLeave={() => { cancelPendingOpen(); setHover(null); }}
        >
          {nick}
        </span>
        {prefs.showHostsInActivity && mask && <span class="sys-host"> ({mask})</span>}
        {msg.text.slice(splitAt)}{suffix}
      </span>
      {profile?.anchor && (
        <NickProfileCard
          nick={nick}
          member={member}
          avatarUrl={avatarFor?.(nick)}
          anchor={profile.anchor}
          actions={buildNickContextActions(nick, nickActions, mask)}
          profiles={nickActions?.profiles}
          line={line}
          onClose={() => setProfile(null)}
        />
      )}
      {profile && !profile.anchor && (
        <NickSheet
          nick={nick}
          member={member}
          avatarUrl={avatarFor?.(nick)}
          actions={buildNickContextActions(nick, nickActions, mask)}
          profiles={nickActions?.profiles}
          line={line}
          onClose={() => setProfile(null)}
        />
      )}
      {menu && (
        <NickContextMenu
          x={menu.x}
          y={menu.y}
          title={nick}
          actions={buildNickContextActions(nick, nickActions, mask)}
          onClose={() => setMenu(null)}
        />
      )}
      {hover && createPortal(
        <MessageNickHoverCard
          nick={nick}
          member={member}
          seen={nickActions?.profiles?.seen?.(nick)}
          line={line}
          top={hover.top}
          left={hover.left}
        />,
        document.body,
      )}
    </div>
  );
}

// Compact hover card for a nick that appears inside a message. Differs
// from the UserPanel's card in that we may not have full WHOIS state
// for the speaker (the channel's member list may have parted them
// already, or we joined after their last activity). Falls back to nick-
// only when the member record is null.
function MessageNickHoverCard({
  nick, member, seen, line, top, left,
}: { nick: string; member: ChatMember | null; seen?: SeenRecord; line?: LineIdentity; top: number; left: number }) {
  // Anchor the card just below the nick by default so it doesn't cover
  // the message text; above it when there's no room below.
  const CARD_WIDTH = 240;
  const cardTop = top + 24;
  const cardLeft = Math.max(8, Math.min(left, window.innerWidth - CARD_WIDTH - 8));
  const ref = useRef<HTMLDivElement>(null);
  useFitInWindow(ref, cardTop, top - 6);
  const role = ROLE_BADGES[member?.prefix ?? ''];
  const meta = primaryRows(profileRows(nick, member));
  return (
    <div
      ref={ref}
      class="nick-hovercard nick-hovercard-portal"
      role="tooltip"
      style={`top: ${cardTop}px; left: ${cardLeft}px; width: ${CARD_WIDTH}px;`}
    >
      <div class="nick-hovercard-head">
        <span class="nick-hovercard-nick">{nick}</span>
        {role && member && (
          <RoleBadge prefix={member.prefix} class={`nick-hovercard-role nick-hovercard-role-${role.kind}`} />
        )}
      </div>
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
      <RememberedDetails nick={nick} member={member} seen={seen} line={line} copyable={false} />
    </div>
  );
}

interface MessageListProps {
  /** The active channel's message list, as a signal — reading `.value` in
   *  render auto-subscribes ONLY to this channel's changes, so a metadata
   *  emit (members/typing/unread for any channel) does not re-render the list. */
  messages: Signal<ChatMessage[]>;
  members: ChatMember[];
  myNick: string;
  scrollRef: Ref<HTMLDivElement>;
  nickActions?: NickActions;
  /** Currently-active channel name. Used as the reset key for the
   *  "freshness baseline" — messages whose timestamp predates the
   *  switch to this channel don't animate in. */
  channelName: string | null;
  /** Resolve a nick to its profile-image URL (Boson members). */
  avatarFor?: (nick: string) => string | undefined;
  /** Chathistory scrollback: pull older messages above the current top.
   *  Triggered on scroll-to-top + a manual button. Absent / unsupported →
   *  no affordance. */
  onLoadOlder?: () => void;
  // Whether the user reads at the bottom (on change).
  onViewport?: (channel: string, atBottom: boolean) => void;
  historySupported?: boolean;
  historyLoading?: boolean;
  historyExhausted?: boolean;
  /** Set when a scroll-back request failed (e.g. no server response). Shown
   *  in the ribbon as a retryable error. */
  historyError?: string;
  /** Shown above the first message when there's no scrollback to load (the
   *  server keeps no history, or not for you): why the conversation starts
   *  where it does, instead of a blank pane. */
  beginningNote?: string;
  /** Scroll to this message (and flash it) whenever `seq` changes: a search
   *  result opened here. (A reply's original is jumped to from its quote.) */
  jump?: { id: string; seq: number } | null;
  /** Search: the rows holding a match are marked (the one at `currentId`
   *  most), and the query highlighted in their text. */
  search?: ChatSearchMarks | null;
  /** Back to the bottom (the newest lines) whenever this changes. */
  toLatest?: number;
  /** Originals of replies that aren't loaded, fetched on their own. */
  replyContext?: ReplyContextSource | null;
}

/** Where a reply's original comes from when it isn't in the list
 *  (ChatService.replyContext / requestReplyContext for the conversation). */
export interface ReplyContextSource {
  /** The original; null when it can't be had; undefined while fetching. */
  get(msgid: string): ChatMessage | null | undefined;
  request(msgids: readonly string[]): void;
  /** Changes when a fetched original arrives. */
  version: Signal<number>;
}

// How many pages of older history a reply quote's click loads, at most,
// looking for its original.
const SEEK_MAX_PAGES = 10;

// "Show guessed replies" (Settings → Chat & media), live.
function useGuessedReplies(): boolean {
  const [on, setOn] = useState(() => getChatDisplaySettings().guessedReplies);
  useEffect(() => onChatDisplaySettingsChange(() => setOn(getChatDisplaySettings().guessedReplies)), []);
  return on;
}

export interface ChatSearchMarks {
  query: string;
  matchIds: ReadonlySet<string>;
  currentId: string | null;
}

// Every message id a row shows (a folded group or block shows several).
function rowMessageIds(item: RenderItem): readonly ChatMessage[] {
  return item.type === 'msg' ? [item.msg] : item.items;
}

// The CSS Custom Highlight API (no DOM changes, so the windowed rows and
// their memoised text stay as they are): `chat-search` over every match on
// screen, `chat-search-current` over the current match's.
type HighlightRegistry = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
function highlights(): { registry: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const H = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && H ? { registry: css.highlights, Highlight: H } : null;
}

function matchRanges(root: Element, needle: string): Range[] {
  const out: Range[] = [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase();
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
      const r = doc.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + needle.length);
      out.push(r);
    }
  }
  return out;
}

// The message text inside a row (not names, times or toolbars).
const SEARCH_TEXT_SELECTOR = '.message-row-text-body, .message-row-doc, .message-action-text, .message-preblock .message-row-body > :not(.message-row-header)';

// Scroll container + message rows. Owns the grouped-rendering decision so
// the view doesn't need to know how messages stitch together visually.
//
// Windowed: only the rows on screen, plus OVERSCAN px each side, are in the
// DOM (virtual-list.ts does the math). Rows off screen are spacers of their
// measured height (HeightCache, by message id; an estimate until a row has
// been seen), so the scrollbar is right and a row's images, embeds and
// players are released once it's far enough away. The reader's place is
// kept across changes: at the bottom it stays at the bottom (live lines,
// images loading); scrolled up, the row at the top of the viewport stays
// where it is when older pages are prepended, rows above change height or
// rows are trimmed.
//
// New-message entrance animation is gated by `freshnessBaseline`: messages
// whose timestamp postdates the most recent channel switch animate as
// they mount (once: not again when scrolled back into view).
const OVERSCAN = 800;
// Rows rendered before the viewport has been measured (the first frame).
const INITIAL_ROWS = 40;
// Load-older fires once the ribbon above the rows comes within this much of
// the viewport's top (an IntersectionObserver over the scroller).
export const LOAD_OLDER_MARGIN_PX = 120;
const rowHeights = new HeightCache();
// The user's scroll has stopped this long after its last event: the top
// spacer's skew is settled then.
const SCROLL_IDLE_MS = 150;
// A scroll event this soon after the user's input on the list is theirs.
const INPUT_SCROLL_MS = 400;
// Older lines wait at most this long for the user's scroll to stop.
const HOLD_OLDER_MAX_MS = 1500;
// Measuring ahead while the list is still (see MessageList): rows up to this
// far above the viewport, this many new ones per pass, never more than
// IDLE_MEASURE_SPAN rows in the DOM above the usual window.
const IDLE_MEASURE_PX = 4000;
const IDLE_MEASURE_BATCH = 30;
const IDLE_MEASURE_SPAN = 90;

interface ListRow {
  key: string;
  item: RenderItem;
  grouped: boolean;
}

function listRows(items: readonly RenderItem[], guessedReplies = true): ListRow[] {
  const rows: ListRow[] = [];
  // Track the previous *rendered chat message* for the grouping decision.
  // Reset across a collapsed activity block so a message that follows a
  // join/quit burst always starts a fresh group (the block is a visual
  // separator).
  let prevMsg: ChatMessage | null = null;
  for (const item of items) {
    if (item.type === 'activity' || item.type === 'preblock') {
      prevMsg = null;
      rows.push({ key: item.id, item, grouped: false });
      continue;
    }
    const grouped = shouldGroup(prevMsg, item.msg, guessedReplies);
    prevMsg = item.msg;
    rows.push({ key: item.msg.id, item, grouped });
  }
  return rows;
}

export const MessageList = memo(function MessageList({
  messages, members, myNick, scrollRef, nickActions, channelName, avatarFor,
  onLoadOlder, onViewport, historySupported, historyLoading, historyExhausted, historyError, beginningNote,
  jump, search, toLatest = 0, replyContext,
}: MessageListProps) {
  // Reading `.value` subscribes THIS component to the channel's message signal.
  // A metadata emit that re-renders the parent passes the same signal ref, so
  // memo() bails — the list only re-renders when its messages actually change
  // (or a non-signal prop like members/history flags does).
  const allMsgs = messages.value;
  // The user's own scrolling (virtual-list.ts placeAnchored): when they last
  // used the wheel / keys / a finger / the scrollbar on the list, and when a
  // scroll event last followed from that (a fling or a smooth scroll keeps
  // going after the input). A scroll event with neither is the browser's
  // (the list's viewport re-sized and scrollTop clamped), not the user
  // leaving the bottom.
  const lastInput = useRef(-Infinity);
  const pointerHeld = useRef(false);
  const lastUserScroll = useRef(-Infinity);
  // A finger is on the list (touch screens). While it is, the list doesn't
  // stick itself to the bottom: a drag up from the bottom starts inside
  // AT_BOTTOM_SLACK, and re-sticking there pulled the list back down
  // against the finger until the drag got past the slack.
  const touching = useRef(false);
  const userScrolling = (): boolean =>
    touching.current || pointerHeld.current || performance.now() - lastUserScroll.current < SCROLL_IDLE_MS;
  const [noLayout, setNoLayout] = useState(false);
  // Older lines that arrive while the user is scrolling (a fling up to the
  // top, a finger still down, the wheel still going) wait until the scroll
  // stops: keeping the reader's row in place under a page put in above takes
  // a scrollTop write, and one mid-scroll cancels the browser's smooth
  // scroll, stops an iOS fling or fights its bounce at the top: the list
  // lurched. Held at most HOLD_OLDER_MAX_MS (a lost touchend).
  const shownFirst = useRef<ChatMessage | null>(null);
  const holdSince = useRef<number | null>(null);
  let hold = 0;
  const first = shownFirst.current;
  if (!noLayout && first && allMsgs[0] !== first && allMsgs.length > 0 && userScrolling()) {
    if (holdSince.current === null || performance.now() - holdSince.current < HOLD_OLDER_MAX_MS) {
      const k = allMsgs.indexOf(first);
      if (k > 0) hold = k;
    }
  }
  if (hold === 0) holdSince.current = null;
  else if (holdSince.current === null) holdSince.current = performance.now();
  const msgs = useMemo(() => (hold > 0 ? allMsgs.slice(hold) : allMsgs), [allMsgs, hold]);
  shownFirst.current = msgs[0] ?? null;
  const heldBack = useRef(false);
  heldBack.current = hold > 0;
  const guessedReplies = useGuessedReplies();
  const rows = useMemo(() => listRows(buildRenderItems(msgs), guessedReplies), [msgs, guessedReplies]);
  // Each message's row key, and each row's messages (for the anchor: see
  // virtual-list.ts locateAnchor).
  const rowIndex = useMemo(() => {
    const rowOf = new Map<string, string>();
    const idsOf = new Map<string, string[]>();
    for (const r of rows) {
      const ids = rowMessageIds(r.item).map((m) => m.id);
      idsOf.set(r.key, ids);
      for (const id of ids) rowOf.set(id, r.key);
    }
    return { rowOf, idsOf };
  }, [rows]);
  const rowIndexRef = useRef(rowIndex);
  rowIndexRef.current = rowIndex;
  const anchorAt = (l: Layout, top: number): Anchor | null => {
    const a = captureAnchor(l, top);
    return a ? { ...a, ids: rowIndexRef.current.idsOf.get(a.key) } : null;
  };
  // Replies find the message they answer by its msgid (a tag), or by its
  // local id (a reply by its text: replies.ts).
  const { byMsgid, byId } = useMemo(() => {
    const byMsgid = new Map<string, ChatMessage>();
    const byId = new Map<string, ChatMessage>();
    for (const x of msgs) {
      if (x.msgid) byMsgid.set(x.msgid, x);
      byId.set(x.id, x);
    }
    return { byMsgid, byId };
  }, [msgs]);
  // Reading the version re-renders the list when a fetched original lands.
  void replyContext?.version.value;
  // Originals the rows on screen are missing, asked for after the render.
  const missingOriginals: string[] = [];
  const parentOf = (m: ChatMessage): ChatMessage | null | 'loading' | undefined => {
    if (m.replyTo) {
      const p = byMsgid.get(m.replyTo);
      if (p) return p;
      const c = replyContext ? replyContext.get(m.replyTo) : null;
      if (c === undefined) missingOriginals.push(m.replyTo);
      return c === undefined ? 'loading' : c;
    }
    if (m.replyToId) {
      if (m.replyGuess && !guessedReplies) return undefined;
      return byId.get(m.replyToId);
    }
    return undefined;
  };
  useEffect(() => {
    if (replyContext && missingOriginals.length > 0) replyContext.request(missingOriginals);
  });
  // The row index holding a message (by local id).
  const rowIndexOf = (id: string): number => rows.findIndex((r) => rowMessageIds(r.item).some((m) => m.id === id));
  // A jump to a row: placed once it's laid out (see the layout effect), then
  // flashed.
  const pendingJump = useRef<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const requestJump = (id: string): void => {
    if (rowIndexOf(id) < 0) return;
    pendingJump.current = id;
    atBottomRef.current = false;
    setHeightsVersion((n) => n + 1);
  };
  const requestJumpRef = useRef(requestJump);
  requestJumpRef.current = requestJump;
  // A reply quote's click: to the original, loading older pages until it's
  // there (at most SEEK_MAX_PAGES).
  const seek = useRef<{ msgid: string; pages: number } | null>(null);
  const [seekTick, setSeekTick] = useState(0);
  const jumpToMessage = (t: ChatMessage): void => {
    const hit = byId.get(t.id) ?? (t.msgid ? byMsgid.get(t.msgid) : undefined);
    if (hit) { seek.current = null; requestJump(hit.id); return; }
    if (!t.msgid || !onLoadOlder || !historySupported || historyExhausted) return;
    seek.current = { msgid: t.msgid, pages: 0 };
    setSeekTick((n) => n + 1);
  };
  const jumpToMessageRef = useRef(jumpToMessage);
  jumpToMessageRef.current = jumpToMessage;
  useEffect(() => {
    const sk = seek.current;
    if (!sk) return;
    const hit = byMsgid.get(sk.msgid);
    if (hit) { seek.current = null; requestJumpRef.current(hit.id); return; }
    if (historyLoading) return;
    if (historyExhausted || (sk.pages > 0 && historyError) || sk.pages >= SEEK_MAX_PAGES) { seek.current = null; return; }
    sk.pages++;
    onLoadOlder?.();
  }, [byMsgid, historyLoading, historyExhausted, historyError, seekTick]);
  // Stable for the memoised rows (a reply quote's click).
  const onJumpTo = useMemo(() => (t: ChatMessage) => jumpToMessageRef.current(t), []);
  useEffect(() => { if (jump) requestJumpRef.current(jump.id); }, [jump?.seq]);
  // Jump to latest: stick to the bottom again (the next layout pass puts it there).
  useEffect(() => {
    if (!toLatest) return;
    pendingJump.current = null;
    atBottomRef.current = true;
    setHeightsVersion((n) => n + 1);
  }, [toLatest]);
  useEffect(() => {
    if (!flashKey) return undefined;
    const t = setTimeout(() => setFlashKey(null), 1600);
    return () => clearTimeout(t);
  }, [flashKey]);
  const freshnessBaseline = useRef<number>(Date.now());
  const animated = useRef(new Set<string>());
  const elRef = scrollRef as { current: HTMLDivElement | null };
  const topSpacer = useRef<HTMLDivElement | null>(null);
  // The viewport: scrollTop and height, from scroll / resize (null until
  // measured; `noLayout` when there's no layout at all — jsdom).
  const [view, setView] = useState<{ top: number; height: number } | null>(null);
  const [heightsVersion, setHeightsVersion] = useState(0);
  // Live "is the viewport parked at the bottom?" flag, updated from real scroll
  // events. Defaults true so the first messages in a channel stick before the
  // user has scrolled at all.
  const atBottomRef = useRef(true);
  const anchorRef = useRef<Anchor | null>(null);
  // The scrollTop the list itself last set (its scroll event isn't the
  // user's).
  const setByUs = useRef<number | null>(null);
  // Where the viewport was last placed (or seen), on which layout.
  const placedTop = useRef<number | null>(null);
  const placedLayout = useRef<Layout | null>(null);
  // The viewport's size then: a scroll that comes with a new size (a phone
  // rotated, the keyboard opening) is the browser re-clamping, not the user.
  const placedSize = useRef<string | null>(null);
  const sizeOf = (el: HTMLElement): string => `${el.clientWidth}x${el.clientHeight}`;
  const layoutRef = useRef<Layout | null>(null);
  // The load-older ribbon (watched for coming into view).
  const ribbonRef = useRef<HTMLDivElement | null>(null);
  // The user has scrolled this conversation since it was shown: until then
  // a ribbon in view (a short conversation) doesn't pull on its own.
  const userScrolled = useRef(false);
  // How much taller the top spacer is than the rows it stands for (see
  // placeAnchored): the reader's row kept in place mid-scroll without
  // writing scrollTop. Settled once the scrolling stops.
  const skewRef = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownChannel = useRef<string | null | undefined>(undefined);
  const onViewportRef = useRef(onViewport);
  onViewportRef.current = onViewport;
  const reportedBottom = useRef<boolean | null>(null);
  const reportBottom = (v: boolean): void => {
    atBottomRef.current = v;
    if (reportedBottom.current === v || !channelName) return;
    reportedBottom.current = v;
    onViewportRef.current?.(channelName, v);
  };

  const layout = new Layout(rows.map((r) => r.key), rowHeights, topSpacer.current?.offsetTop ?? 0);
  layoutRef.current = layout;
  let start = 0;
  let end = rows.length;
  if (!noLayout) {
    if (view) ({ start, end } = layout.range(view.top, view.height, OVERSCAN));
    else start = Math.max(0, rows.length - INITIAL_ROWS);
    // Not scrolling: measure ahead. Rows above that have never been laid out
    // are only guessed at (the average height; a pasted document is many
    // times that); measured mid-scroll, the difference has to be made up
    // under the user. So while the list is still, the nearest of them (up to
    // IDLE_MEASURE_PX above) are put in the DOM a batch at a time and
    // measured: by the time the user scrolls there they're known.
    if (view && start > 0 && !pendingJump.current && !userScrolling()) {
      const lo = layout.indexAt(Math.max(layout.top, view.top - IDLE_MEASURE_PX));
      const floor = Math.max(lo, start - IDLE_MEASURE_SPAN);
      for (let i = start - 1; i >= floor; i--) {
        if (rowHeights.get(rows[i]!.key) === undefined) {
          start = Math.max(floor, i - IDLE_MEASURE_BATCH + 1);
          break;
        }
      }
    }
  }
  const topModel = noLayout ? 0 : layout.offsetOf(start) - layout.top;
  const topPad = noLayout ? 0 : Math.max(0, topModel + skewRef.current);
  const bottomPad = noLayout ? 0 : layout.total - layout.offsetOf(end);

  // Rows change height after they're laid out (an image or embed loads, the
  // window is resized): one observer over the rows in the DOM.
  const observed = useRef(new Set<Element>());
  const ro = useMemo(() => (typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => setHeightsVersion((n) => n + 1))), []);
  useEffect(() => () => ro?.disconnect(), [ro]);
  const pendingSwitch = useRef(false);

  // After every render: measure the rows in the DOM; when a height changed,
  // render again (the spacers follow) before placing the viewport; else put
  // it where it belongs: the bottom, or the anchor row where it was.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (shownChannel.current !== channelName) {
      shownChannel.current = channelName;
      pendingSwitch.current = true;
      freshnessBaseline.current = Date.now();
      animated.current = new Set(rows.map((r) => r.key));
      reportedBottom.current = null;
      reportBottom(true);
      userScrolled.current = false;
    }
    if (noLayout) return;
    if (el.clientHeight === 0 && el.scrollHeight === 0) { setNoLayout(true); return; }
    // Scrolled since we last placed it, and the scroll event not handled
    // yet: that's the user's place now (on the layout they scrolled).
    const resized = placedSize.current !== null && placedSize.current !== sizeOf(el);
    if (!resized && placedTop.current !== null && Math.abs(el.scrollTop - placedTop.current) > 1 && placedLayout.current) {
      anchorRef.current = anchorAt(placedLayout.current, Math.max(0, el.scrollTop - skewRef.current));
      const movedUp = el.scrollTop < placedTop.current;
      atBottomRef.current = userAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight, movedUp, AT_BOTTOM_SLACK);
      placedTop.current = el.scrollTop;
    }
    const present = new Set<Element>();
    let changed = false;
    for (const child of Array.from(el.querySelectorAll<HTMLElement>('.vrow'))) {
      present.add(child);
      if (ro && !observed.current.has(child)) { ro.observe(child); observed.current.add(child); }
      const key = child.dataset['vkey'];
      if (key && rowHeights.set(key, child.getBoundingClientRect().height)) changed = true;
    }
    for (const gone of Array.from(observed.current)) {
      if (!present.has(gone)) { ro?.unobserve(gone); observed.current.delete(gone); }
    }
    if (changed) { setHeightsVersion((n) => n + 1); return; }
    // What's above the rows (the load-older ribbon) may have changed size
    // in this very render: lay out from where they start now.
    const top = topSpacer.current?.offsetTop ?? layout.top;
    const now = top === layout.top ? layout : new Layout(layout.keys, rowHeights, top);
    layoutRef.current = now;
    // The top spacer: the rows above `start` in the model, plus the skew.
    const spacerModel = now.offsetOf(start) - now.top;
    const setSkew = (v: number): void => {
      skewRef.current = v;
      const sp = topSpacer.current;
      const h = `${Math.max(0, spacerModel + v)}px`;
      if (sp && sp.style.height !== h) sp.style.height = h;
    };
    const switching = pendingSwitch.current;
    const jumpId = switching ? null : pendingJump.current;
    const toBottom = switching || (atBottomRef.current && !touching.current);
    // Anything but keeping the reader's row (the bottom, a jump, another
    // conversation) starts from a settled spacer.
    if (skewRef.current !== 0 && (toBottom || jumpId)) {
      const st = el.scrollTop - skewRef.current;
      setSkew(0);
      el.scrollTop = Math.max(0, st);
      setByUs.current = el.scrollTop;
    }
    // The reader's row, re-keyed if it took in lines from above.
    const located = toBottom ? null : locateAnchor(now, anchorRef.current, (id) => rowIndex.rowOf.get(id));
    if (located && located !== anchorRef.current) anchorRef.current = located;
    const anchorTarget = toBottom ? null : restoreAnchor(now, located);
    const target = toBottom ? bottomOf(el.scrollHeight, el.clientHeight) : anchorTarget;
    pendingSwitch.current = false;
    // iOS rubber-bands past the top (scrollTop < 0) and springs back by
    // itself: putting it at 0 from here would cut the bounce short, every
    // frame, and fight the user's finger.
    const bouncingAtTop = !toBottom && el.scrollTop < 0 && target === 0;
    // Likewise past the bottom (scrollTop beyond the end).
    const bouncingAtBottom = toBottom && !switching && target !== null && el.scrollTop > target;
    if (toBottom) {
      if (target !== null && !bouncingAtBottom && Math.abs(target - el.scrollTop) > 0.5) {
        el.scrollTop = target;
        setByUs.current = el.scrollTop;
      }
    } else if (!bouncingAtTop) {
      // The reader's row where it was: mid-scroll by the spacer, else (and
      // once the scroll stops) by scrollTop.
      const place = placeAnchored({
        scrollTop: el.scrollTop, target: anchorTarget, skew: skewRef.current, topPad: spacerModel, start, active: userScrolling(), spacerTop: now.top,
      });
      if (place.skew !== skewRef.current) setSkew(place.skew);
      if (place.scrollTop !== null) {
        el.scrollTop = place.scrollTop;
        setByUs.current = el.scrollTop;
      }
    }
    // A jump (search, a reply's original): bring the row to the middle of
    // the viewport — first to where the layout puts it, so it's rendered,
    // then (next pass) by where it really is. It becomes the reading place.
    let jumped = false;
    if (jumpId) {
      const idx = rowIndexOf(jumpId);
      const key = idx >= 0 ? now.keys[idx] : undefined;
      if (!key) pendingJump.current = null;
      else {
        const rowEl = Array.from(el.querySelectorAll<HTMLElement>('.vrow')).find((v) => v.dataset['vkey'] === key);
        const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
        let want: number;
        if (rowEl) {
          const r = rowEl.getBoundingClientRect();
          const box = el.getBoundingClientRect();
          want = el.scrollTop + (r.top - box.top) - Math.max(16, (el.clientHeight - r.height) / 2);
          pendingJump.current = null;
          setFlashKey(key);
        } else {
          want = now.offsetOf(idx) - el.clientHeight / 2;
        }
        want = Math.min(maxTop, Math.max(0, want));
        if (Math.abs(want - el.scrollTop) > 0.5) { el.scrollTop = want; setByUs.current = el.scrollTop; }
        jumped = true;
        anchorRef.current = anchorAt(now, el.scrollTop);
        reportBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK);
      }
    }
    const modelTop = el.scrollTop - skewRef.current;
    // The anchor stays the row the user was reading (re-taken only when
    // they scroll): re-taking it here, from rows above that are still
    // estimates, would drift by the estimate's error once they're measured.
    if (!jumped && (toBottom || !anchorRef.current || target === null)) anchorRef.current = anchorAt(now, Math.max(0, modelTop));
    placedTop.current = el.scrollTop;
    placedLayout.current = now;
    placedSize.current = sizeOf(el);
    if (!view || Math.abs(view.top - modelTop) > 1 || view.height !== el.clientHeight) {
      setView({ top: modelTop, height: el.clientHeight });
    } else if (pendingJump.current) {
      // Not rendered yet but already in place: measure it next pass.
      setHeightsVersion((n) => n + 1);
    }
  });

  // Search highlights over the rows on screen, after every render (rows
  // come and go as the list scrolls).
  const searchNeedle = search?.query.trim().toLowerCase() ?? '';
  useLayoutEffect(() => {
    const api = highlights();
    const el = elRef.current;
    if (!api) return;
    if (!el || !searchNeedle || !search) {
      api.registry.delete('chat-search');
      api.registry.delete('chat-search-current');
      return;
    }
    const all: Range[] = [];
    const current: Range[] = [];
    for (const v of Array.from(el.querySelectorAll<HTMLElement>('.vrow-search-match'))) {
      const isCurrent = v.classList.contains('vrow-search-current');
      for (const t of Array.from(v.querySelectorAll(SEARCH_TEXT_SELECTOR))) {
        for (const r of matchRanges(t, searchNeedle)) (isCurrent ? current : all).push(r);
      }
    }
    api.registry.set('chat-search', new api.Highlight(...all));
    api.registry.set('chat-search-current', new api.Highlight(...current));
  });
  useEffect(() => () => {
    const api = highlights();
    api?.registry.delete('chat-search');
    api?.registry.delete('chat-search-current');
  }, []);

  // The viewport's own size (window resize, a strip above appearing).
  useEffect(() => {
    const el = elRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const vro = new ResizeObserver(() => setHeightsVersion((n) => n + 1));
    vro.observe(el);
    return () => vro.disconnect();
  }, [elRef]);
  void heightsVersion;

  // Briefly confirm a completed load: flash "Loaded older messages" when a
  // request resolves (loading true→false with no error).
  const [justLoaded, setJustLoaded] = useState(false);
  const wasLoading = useRef(false);
  const loadingShown = !!historyLoading || hold > 0;
  useEffect(() => {
    const was = wasLoading.current;
    wasLoading.current = loadingShown;
    if (was && !loadingShown && !historyError) {
      setJustLoaded(true);
      const t = setTimeout(() => setJustLoaded(false), 1800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [loadingShown, historyError]);
  // Load-older, from the scroll position. Two triggers, either enough:
  //   - the ribbon above the rows comes into view (an IntersectionObserver
  //     on the scroller, LOAD_OLDER_MARGIN_PX early). It doesn't depend on
  //     scroll-event timing or an exact scrollTop, which touch scrolling
  //     makes fragile: on iOS a fling ends in a rubber-band bounce past the
  //     top (negative scrollTop) while the list re-places itself, and a
  //     scroll event taken for a re-size returns before the check;
  //   - scroll events that settle at the very top (debounced), where there
  //     is no IntersectionObserver.
  // Either way only once the user has touched / scrolled this conversation,
  // and not while a request is in flight, done, or failed (the ribbon's
  // button retries).
  const live = useRef({ onLoadOlder, historySupported, historyLoading, historyExhausted, historyError });
  live.current = { onLoadOlder, historySupported, historyLoading, historyExhausted, historyError };
  // Lines held back (see `hold`): let them settle in first, not ask for more.
  const holding = hold > 0;
  useEffect(() => {
    if (!holding) return undefined;
    const t = setTimeout(() => setHeightsVersion((n) => n + 1), HOLD_OLDER_MAX_MS + 20);
    return () => clearTimeout(t);
  }, [holding]);
  const maybeLoadOlder = (): void => {
    const p = live.current;
    if (heldBack.current) return;
    if (!p.onLoadOlder || !p.historySupported || p.historyLoading || p.historyExhausted || p.historyError) return;
    if (!userScrolled.current) return;
    p.onLoadOlder();
  };
  const maybeLoadRef = useRef(maybeLoadOlder);
  maybeLoadRef.current = maybeLoadOlder;
  // The user's own input on the list (not just its scroll events, which
  // the list's own re-placing and a viewport re-size also produce).
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const input = (): void => { lastInput.current = performance.now(); };
    const mark = (): void => { userScrolled.current = true; input(); };
    const down = (): void => { touching.current = true; input(); };
    // Finger lifted: place the list once more (a momentum scroll that ends
    // at the bottom sticks there again via the scroll events).
    const up = (): void => { touching.current = false; input(); setHeightsVersion((n) => n + 1); };
    // The scrollbar dragged (or the list pressed): a scroll while it's held
    // is the user's.
    const press = (): void => { pointerHeld.current = true; input(); };
    const release = (): void => {
      if (!pointerHeld.current) return;
      pointerHeld.current = false;
      input();
      if (skewRef.current !== 0 || heldBack.current) setHeightsVersion((n) => n + 1);
    };
    const opts = { passive: true } as const;
    for (const t of ['touchmove', 'wheel'] as const) el.addEventListener(t, mark, opts);
    el.addEventListener('touchstart', down, opts);
    el.addEventListener('touchend', up, opts);
    el.addEventListener('touchcancel', up, opts);
    el.addEventListener('keydown', input, opts);
    el.addEventListener('pointerdown', press, opts);
    window.addEventListener('pointerup', release, opts);
    window.addEventListener('pointercancel', release, opts);
    return () => {
      for (const t of ['touchmove', 'wheel'] as const) el.removeEventListener(t, mark);
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
      el.removeEventListener('keydown', input);
      el.removeEventListener('pointerdown', press);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [elRef]);
  useEffect(() => {
    const root = elRef.current;
    const ribbon = ribbonRef.current;
    if (!root || !ribbon || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      if (entry.isIntersecting) maybeLoadRef.current();
    }, { root, rootMargin: `${LOAD_OLDER_MARGIN_PX}px 0px 0px 0px` });
    io.observe(ribbon);
    return () => io.disconnect();
  }, [elRef, historySupported]);
  // A page came in and the ribbon is still in view (the page was short of a
  // screenful, or the list kept its place right under it): keep going.
  // Only when rows were added, so a page that brought nothing doesn't loop.
  const rowsAtLoad = useRef<number | null>(null);
  useEffect(() => {
    if (historyLoading) { rowsAtLoad.current = msgs.length; return; }
    const before = rowsAtLoad.current;
    rowsAtLoad.current = null;
    if (before === null || msgs.length <= before || noLayout) return;
    // Measured now (the list has re-placed itself under the new rows), not
    // the observer's last word, which predates them.
    const root = elRef.current;
    const ribbon = ribbonRef.current;
    if (!root || !ribbon) return;
    if (ribbon.getBoundingClientRect().bottom >= root.getBoundingClientRect().top - LOAD_OLDER_MARGIN_PX) maybeLoadRef.current();
  }, [historyLoading]);
  // Scroll events: debounced (they come in bursts), then re-confirm the
  // viewport is still at the top before pulling.
  const scrollDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => () => {
    if (scrollDebounce.current) clearTimeout(scrollDebounce.current);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);
  const onScroll = (e: Event): void => {
    const el = e.currentTarget as HTMLDivElement;
    // The viewport changed size and the browser moved scrollTop to fit:
    // the next layout pass re-places it (the bottom, or the anchor).
    if (placedSize.current !== null && placedSize.current !== sizeOf(el)) {
      setHeightsVersion((n) => n + 1);
      return;
    }
    // Our own scrollTop adjustments don't move the anchor; the user's do.
    const ours = setByUs.current !== null && Math.abs(setByUs.current - el.scrollTop) < 1;
    setByUs.current = null;
    // The user's scroll: right after their input on the list, or following
    // on from their last one (a fling, a smooth scroll animating).
    const t = performance.now();
    const user = !ours && (touching.current || pointerHeld.current
      || t - lastInput.current < INPUT_SCROLL_MS || t - lastUserScroll.current < SCROLL_IDLE_MS);
    // Track bottom-stickiness on every scroll (including our own programmatic
    // scroll-to-bottom) — this drives live-append autoscroll. The user
    // scrolling up has left the bottom, even inside the slack.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const movedUp = placedTop.current !== null && el.scrollTop < placedTop.current - 0.5;
    reportBottom(user ? userAtBottom(distance, movedUp, AT_BOTTOM_SLACK) : distance <= AT_BOTTOM_SLACK);
    if (user) {
      lastUserScroll.current = t;
      // Stopped scrolling: settle the top spacer (one scrollTop write, with
      // nothing in flight to interrupt).
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        // Settle the spacer, let held lines in, measure ahead.
        setHeightsVersion((n) => n + 1);
      }, SCROLL_IDLE_MS + 20);
    }
    if (!ours && (placedTop.current === null || Math.abs(el.scrollTop - placedTop.current) > 1)) {
      userScrolled.current = true;
      if (placedLayout.current) anchorRef.current = anchorAt(placedLayout.current, Math.max(0, el.scrollTop - skewRef.current));
    }
    placedTop.current = el.scrollTop;
    if (!noLayout && frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setView({ top: el.scrollTop - skewRef.current, height: el.clientHeight });
      });
    }
    if (!onLoadOlder || !historySupported || historyLoading || historyExhausted || historyError) return;
    if (scrollDebounce.current) clearTimeout(scrollDebounce.current);
    scrollDebounce.current = setTimeout(() => {
      scrollDebounce.current = null;
      if (el.scrollTop <= 4) maybeLoadOlder();
    }, 250);
  };

  return (
    <div class="chat-messages" ref={scrollRef} onScroll={onScroll}>
      <div class="messages-inner">
        {historySupported && (
          <div class="chat-load-older" ref={ribbonRef}>
            {historyError ? (
              <Button
                variant="secondary"
                size="sm"
                tone="danger"
                class="chat-load-older-btn chat-load-older-error"
                onClick={() => onLoadOlder?.()}
              >
                {historyError} — retry
              </Button>
            ) : loadingShown ? (
              <>
                <BarLoader class="chat-load-older-bar" label="Loading older messages" />
                <span class="chat-load-older-loading">Loading older messages…</span>
              </>
            ) : justLoaded ? (
              <span class="chat-load-older-success">Loaded older messages</span>
            ) : historyExhausted ? (
              <span class="chat-load-older-end">Beginning of history</span>
            ) : (
              <Button variant="secondary" size="sm" class="chat-load-older-btn" onClick={() => onLoadOlder?.()}>
                Load older messages
              </Button>
            )}
          </div>
        )}
        {!historySupported && beginningNote && (
          <div class="chat-beginning-note" role="note">{beginningNote}</div>
        )}
        <div class="vspacer" ref={topSpacer} style={{ height: `${topPad}px` }} aria-hidden="true" />
        {rows.slice(start, end).map(({ key, item, grouped }) => {
          let fresh = false;
          if (item.type === 'msg' || item.type === 'doc') {
            fresh = item.msg.timestamp > freshnessBaseline.current && !animated.current.has(key);
          }
          animated.current.add(key);
          const ids = search && search.matchIds.size > 0 ? rowMessageIds(item) : null;
          const match = !!ids && ids.some((m) => search!.matchIds.has(m.id));
          const current = match && !!search!.currentId && ids!.some((m) => m.id === search!.currentId);
          const replyParent = (item.type === 'msg' || item.type === 'doc') ? parentOf(item.msg) : undefined;
          const vclass = [
            match ? 'vrow-search-match' : '',
            current ? 'vrow-search-current' : '',
            flashKey === key ? 'vrow-flash' : '',
          ].filter(Boolean).join(' ');
          return (
            <VRow key={key} vkey={key} extraClass={vclass}>
              {item.type === 'activity' ? <ActivityGroup items={item.items} members={members} nickActions={nickActions} avatarFor={avatarFor} />
                : item.type === 'preblock' ? <PreBlock items={item.items} avatarFor={avatarFor} />
                : (
                  <MessageRow
                    msg={item.msg}
                    myNick={myNick}
                    members={members}
                    grouped={grouped}
                    nickActions={nickActions}
                    fresh={fresh}
                    avatarFor={avatarFor}
                    doc={item.type === 'doc'}
                    replyParent={replyParent}
                    onJumpTo={onJumpTo}
                  />
                )}
            </VRow>
          );
        })}
        <div class="vspacer" style={{ height: `${bottomPad}px` }} aria-hidden="true" />
      </div>
    </div>
  );
});

// One windowed row (measured by the list, by key).
function VRow({ vkey, extraClass, children }: { vkey: string; extraClass?: string; children: preact.ComponentChildren }) {
  return <div class={extraClass ? `vrow ${extraClass}` : 'vrow'} data-vkey={vkey}>{children}</div>;
}

// Membership churn (join/part/quit) and repeated self-join system lines are
// noise that drowns real conversation — especially after reconnects or app
// restarts, where history replay can stack dozens of identical "You joined #x"
// lines. We fold consecutive runs of these into a single collapsible summary
// once a run gets long enough; short bursts (a couple of joins) still render
// inline so a quiet channel reads naturally.
const ACTIVITY_KINDS: ReadonlySet<ChatMessage['kind']> = new Set(['join', 'part', 'quit', 'system']);
// Runs shorter than this render inline (unchanged); this-or-longer collapse.
export const ACTIVITY_COLLAPSE_MIN = 4;
// Joins / parts / quits in a run that fold it, whatever its length.
const CHURN_KINDS: ReadonlySet<ChatMessage['kind']> = new Set(['join', 'part', 'quit']);
export const CHURN_COLLAPSE_MIN = 2;

export type RenderItem =
  | { type: 'msg'; msg: ChatMessage }
  | { type: 'activity'; id: string; items: ChatMessage[] }
  // Consecutive preformatted lines (box-drawing / pipe tables) from one sender,
  // rendered as a single aligned monospace block (see PreBlock).
  | { type: 'preblock'; id: string; from: string; items: ChatMessage[] }
  // A pasted markdown document: a burst of lines from one sender, joined
  // into one message (msg.text holds every line; id/timestamp are the
  // first line's) and rendered as a document (see MarkdownDoc).
  | { type: 'doc'; msg: ChatMessage; items: ChatMessage[] };

// Preformatted grouping is only meaningful for actual chat lines (a bot's
// table is PRIVMSG/NOTICE), never system/join/quit.
const PREFORMAT_KINDS: ReadonlySet<ChatMessage['kind']> = new Set(['message', 'notice']);

// Walk the message list and fold runs into higher-level items:
//   - long runs of activity-kind messages → one `activity` item
//   - a burst of lines from one sender that reads as markdown → one `doc`
//   - consecutive preformatted lines from the same sender → one `preblock`
// Everything else passes through as individual `msg` items, preserving the
// existing per-message rendering + grouping.
export function buildRenderItems(
  messages: readonly ChatMessage[],
  collapseMin: number = ACTIVITY_COLLAPSE_MIN,
): RenderItem[] {
  const out: RenderItem[] = [];
  let activityRun: ChatMessage[] = [];
  let preRun: ChatMessage[] = [];
  const flushActivity = () => {
    if (activityRun.length === 0) return;
    // Joins and leaves fold as soon as there are two of them, and a quit
    // always folds (even on its own): a line per person coming and going
    // is noise, the one-line summary says what it came to.
    let churn = 0;
    let quit = false;
    for (const m of activityRun) {
      if (CHURN_KINDS.has(m.kind)) churn += 1;
      if (m.kind === 'quit') quit = true;
    }
    if (activityRun.length >= collapseMin || churn >= CHURN_COLLAPSE_MIN || quit) {
      out.push({ type: 'activity', id: `activity-${activityRun[0]!.id}`, items: activityRun });
    } else {
      for (const m of activityRun) out.push({ type: 'msg', msg: m });
    }
    activityRun = [];
  };
  const flushPre = () => {
    if (preRun.length === 0) return;
    out.push({ type: 'preblock', id: `pre-${preRun[0]!.id}`, from: preRun[0]!.from, items: preRun });
    preRun = [];
  };
  // A burst that isn't a document has no tail that is one either; don't
  // re-check each of its lines.
  let checkedTo = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (PREFORMAT_KINDS.has(m.kind) && i > checkedTo) {
      const burst = burstAt(messages, i);
      checkedTo = i + burst.length - 1;
      // The markdown has to be in lines other than tables and ASCII art:
      // those keep the preblock below (table with "show all", banner cards,
      // aligned art) even when a chat line comes with them.
      const texts = burst.map((b) => b.text);
      if (isMarkdownDocument(texts) && hasBlockMarkdown(texts.filter((t) => !isPreformattedLine(t)))) {
        flushActivity();
        flushPre();
        out.push({
          type: 'doc',
          msg: { ...m, text: texts.join('\n') },
          items: burst,
        });
        i += burst.length - 1;
        continue;
      }
    }
    // A blank line outside a document (BLANK_LINE from a paste that isn't
    // markdown) has nothing to show.
    if (PREFORMAT_KINDS.has(m.kind) && !m.text.trim() && !m.redacted) continue;
    if (ACTIVITY_KINDS.has(m.kind)) {
      flushPre();
      activityRun.push(m);
      continue;
    }
    flushActivity();
    if (PREFORMAT_KINDS.has(m.kind) && isPreformattedLine(m.text)) {
      // Break the run when the sender changes so two stacked tables don't merge.
      if (preRun.length > 0 && preRun[preRun.length - 1]!.from !== m.from) flushPre();
      preRun.push(m);
    } else {
      flushPre();
      out.push({ type: 'msg', msg: m });
    }
  }
  flushActivity();
  flushPre();
  return out;
}

// The run of lines starting at messages[i] that one paste produced: same
// sender and kind, each within BURST_GAP_MS of the one before, nothing else
// in between.
function burstAt(messages: readonly ChatMessage[], i: number): ChatMessage[] {
  const first = messages[i]!;
  const run = [first];
  for (let j = i + 1; j < messages.length; j++) {
    const m = messages[j]!;
    const prev = run[run.length - 1]!;
    if (m.kind !== first.kind || m.from !== first.from || m.timestamp - prev.timestamp > BURST_GAP_MS) break;
    run.push(m);
  }
  return run;
}

// Coalesce identical adjacent activity texts into {text, count} so a wall of
// "You joined ##frontend" renders as one line ×40 rather than forty rows.
export function coalesceActivity(items: readonly ChatMessage[]): Array<{ text: string; count: number }> {
  return coalesceActivityLines(items).map(({ msg, count }) => ({ text: msg.text, count }));
}

// coalesceActivity keeping each line's first message (for its sender's
// recorded host). Lines with the same text but a different host stay apart.
export function coalesceActivityLines(items: readonly ChatMessage[]): Array<{ msg: ChatMessage; count: number }> {
  const out: Array<{ msg: ChatMessage; count: number }> = [];
  for (const m of items) {
    const last = out[out.length - 1];
    if (last && last.msg.text === m.text && last.msg.host === m.host) last.count += 1;
    else out.push({ msg: m, count: 1 });
  }
  return out;
}

type Presence = 'popped in' | 'nipped in and out' | 'popped out and back' | 'left';
const PRESENCE_ORDER: readonly Presence[] = ['popped in', 'nipped in and out', 'popped out and back', 'left'];

function nameList(nicks: readonly string[]): string {
  if (nicks.length === 1) return nicks[0]!;
  if (nicks.length <= 3) return `${nicks.slice(0, -1).join(', ')} and ${nicks[nicks.length - 1]}`;
  return `${nicks.slice(0, 2).join(', ')} and ${nicks.length - 2} others`;
}

// What an activity run comes to, per person: where they ended up, not the
// first line of the run (which read "x joined · and 5 more" for someone
// who had long since quit). Joins and leaves (part or quit) per nick:
//   joined, still here          → popped in
//   joined, then gone           → nipped in and out
//   gone, then back             → popped out and back
//   gone                        → left
// Other lines (system notices) follow, coalesced.
export function summarizeActivity(items: readonly ChatMessage[]): string {
  const seen = new Map<string, { first: 'in' | 'out'; last: 'in' | 'out' }>();
  const other: ChatMessage[] = [];
  for (const m of items) {
    const dir = m.kind === 'join' ? 'in' : m.kind === 'part' || m.kind === 'quit' ? 'out' : null;
    if (!dir || !m.from) { other.push(m); continue; }
    const s = seen.get(m.from);
    if (s) s.last = dir; else seen.set(m.from, { first: dir, last: dir });
  }
  const by = new Map<Presence, string[]>();
  for (const [nick, { first, last }] of seen) {
    const p: Presence = first === 'in'
      ? (last === 'in' ? 'popped in' : 'nipped in and out')
      : (last === 'in' ? 'popped out and back' : 'left');
    const list = by.get(p) ?? [];
    list.push(nick);
    by.set(p, list);
  }
  const parts = PRESENCE_ORDER.filter((p) => by.has(p)).map((p) => `${nameList(by.get(p)!)} ${p}`);
  for (const l of coalesceActivity(other)) parts.push(l.count > 1 ? `${l.text} ×${l.count}` : l.text);
  // One line: the first few, then how many more (all of it on expand).
  const MAX = 3;
  return parts.length > MAX ? `${parts.slice(0, MAX).join(' · ')} · and ${parts.length - MAX} more` : parts.join(' · ');
}

// Collapsed summary for an activity run: what it came to (see
// summarizeActivity); expands on click into the full coalesced list.
function ActivityGroup({ items, members, nickActions, avatarFor }: {
  items: ChatMessage[];
  members: ChatMember[];
  nickActions?: NickActions;
  avatarFor?: (nick: string) => string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = expanded ? coalesceActivityLines(items) : [];
  const total = items.length;
  return (
    <div class={`message-activity ${expanded ? 'message-activity-expanded' : ''}`}>
      <button
        type="button"
        class="message-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span class="message-activity-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        {expanded ? (
          <span class="message-activity-summary">{total} channel events</span>
        ) : (
          <span class="message-activity-summary">{summarizeActivity(items)}</span>
        )}
      </button>
      {expanded && (
        <div class="message-activity-lines">
          {lines.map((l, i) => (
            l.msg.kind === 'join' || l.msg.kind === 'part' || l.msg.kind === 'quit' ? (
              <ActivityLine
                key={i}
                msg={l.msg}
                count={l.count}
                members={members}
                nickActions={nickActions}
                avatarFor={avatarFor}
                extraClass="message-activity-line"
              />
            ) : (
              <div key={i} class="message-system message-activity-line">
                <span class="sys-text">{l.msg.text}{l.count > 1 ? ` ×${l.count}` : ''}</span>
              </div>
            )
          ))}
        </div>
      )}
    </div>
  );
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

// Two adjacent messages group when they're from the same author, of the same
// chat-message kind (so an action doesn't visually fuse with regular text),
// and posted within the GROUP_WINDOW.
export function shouldGroup(prev: ChatMessage | null, curr: ChatMessage, guessedReplies = true): boolean {
  if (!prev) return false;
  if (curr.kind !== 'message' && curr.kind !== 'notice') return false;
  // A reply leads with its quote, under its author's name.
  if (curr.replyTo || (curr.replyToId && (guessedReplies || !curr.replyGuess))) return false;
  if (prev.kind !== curr.kind) return false;
  if (prev.from !== curr.from) return false;
  if (curr.timestamp - prev.timestamp > GROUP_WINDOW_MS) return false;
  return true;
}

// IRC-compatible word-boundary check around an arbitrary nick. We can't just
// use \b because the regex word class doesn't cover all IRC nick chars
// (`[]\\{}|^` are nick-legal). The custom char class mirrors NICK_CHAR_RE.
export function containsNickMention(text: string, nick: string): boolean {
  if (!nick) return false;
  const re = new RegExp(
    `(?:^|[^${NICK_BOUNDARY_CHARS}])${escapeRegex(nick)}(?:[^${NICK_BOUNDARY_CHARS}]|$)`,
    'i',
  );
  return re.test(text);
}

// Returns mixed text + <span> children, with each occurrence of myNick wrapped
// in <span class="mention-self">. Word-boundary aware so "al" inside "almost"
// doesn't get marked.
// Punctuation right after a mention (`ada:`), which the pill sits flush to.
const MENTION_FLUSH_RE = /^[:,.;!?)\]'’"]/;

export function renderWithMentions(text: string, myNick: string): preact.ComponentChildren {
  if (!myNick) return text;
  const re = new RegExp(
    `(?<![${NICK_BOUNDARY_CHARS}])(${escapeRegex(myNick)})(?![${NICK_BOUNDARY_CHARS}])`,
    'gi',
  );
  const out: preact.ComponentChildren[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const flush = MENTION_FLUSH_RE.test(text.slice(last));
    out.push(<span class={flush ? 'mention-self mention-flush' : 'mention-self'}>{m[0]}</span>);
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 1 && typeof out[0] === 'string' ? out[0] : out;
}

// Render a chat message body with markdown formatting + inline token
// highlighting (@nick / #channel / self-mention). Token scanning skips code
// spans/blocks — text inside backticks is literal.
// A run of consecutive preformatted lines (box-drawing / pipe table) from one
// sender, rendered as a single aligned, horizontally-scrollable monospace block
// under one header — so a pasted table isn't fragmented by per-line timestamps
// or proportional-font misalignment.
function PreBlock({
  items, avatarFor,
}: { items: ChatMessage[]; avatarFor?: (nick: string) => string | undefined }) {
  const head = items[0]!;
  const time = new Date(head.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = preformattedBody(items.map((m) => m.text));
  // Pasted box-drawing / pipe / ascii tables render as real <table>s (a block
  // may hold more than one); any other monospace block (ascii art, logs, code)
  // stays as aligned <pre>.
  const tables = parseTables(body);
  // Framed bot banners (____ / | text | / ¯¯¯¯) render as cards.
  const banners = tables ? null : parseBanners(body);
  return (
    <div class="message-row message-preblock">
      <div class="message-row-gutter">
        <Avatar nick={head.from} url={avatarFor?.(head.from)} size={30} class="message-avatar" />
      </div>
      <div class="message-row-body">
        <div class="message-row-header">
          <span class="message-row-name">{head.from}</span>
          <span class="message-row-time">{time}</span>
        </div>
        {tables
          ? tables.map((t, i) => <MessageTable key={i} table={t} />)
          : banners
            ? banners.map((b, i) => <MessageBanner key={i} banner={b} />)
            : <pre class="message-preblock-pre">{body}</pre>}
      </div>
    </div>
  );
}

// The text of a preformatted block: formatting codes removed (we don't render
// colours, and the raw controls would break alignment), trailing padding
// dropped, and the indent every line shares taken off so the art sits flush
// left rather than starting a few columns in.
export function preformattedBody(lines: readonly string[]): string {
  const plain = lines.map((l) => stripIrcFormatting(l).replace(/\s+$/, ''));
  const indents = plain.filter((l) => l).map((l) => l.length - l.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return plain.map((l) => l.slice(cut)).join('\n');
}

function MessageBanner({ banner }: { banner: Banner }) {
  return (
    <div class="message-banner">
      {banner.lines.map((line, i) => {
        const parts = splitBannerLine(line);
        return (
          <div key={i} class="message-banner-line">
            {parts
              ? <><span class="message-banner-label">{parts.label}</span><span class="message-banner-value">{parts.value}</span></>
              : <span class="message-banner-value">{line}</span>}
          </div>
        );
      })}
    </div>
  );
}

const TABLE_ROW_CAP = 12;

function MessageTable({ table }: { table: ParsedTable }) {
  const [expanded, setExpanded] = useState(false);
  const many = table.rows.length > TABLE_ROW_CAP;
  const rows = expanded || !many ? table.rows : table.rows.slice(0, TABLE_ROW_CAP);
  return (
    <div class="message-table-block">
      <div class={`message-table-wrap${expanded ? ' is-expanded' : ''}`}>
        <table class="message-table">
          <thead>
            <tr>{table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {many && (
        <Button variant="ghost" size="sm" tone="accent" class="message-table-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '▾ Show less' : `▸ Show all ${table.rows.length} rows`}
        </Button>
      )}
    </div>
  );
}

export function renderMessageBody(
  text: string,
  myNick: string,
  members: { nick: string }[],
): preact.ComponentChildren {
  const tokens = tokenizeMarkdown(stripIrcFormatting(text));
  return tokens.map((t, i) => renderMdToken(t, myNick, members, i));
}

export function renderMdToken(
  t: MdToken,
  myNick: string,
  members: { nick: string }[],
  key: number,
): preact.ComponentChildren {
  switch (t.type) {
    case 'text':
      return <span key={key}>{renderRichText(t.value, myNick, members)}</span>;
    case 'bold':
      return <strong key={key} class="md-bold">{renderRichText(t.value, myNick, members)}</strong>;
    case 'italic':
      return <em key={key} class="md-italic">{renderRichText(t.value, myNick, members)}</em>;
    case 'strike':
      return <s key={key} class="md-strike">{renderRichText(t.value, myNick, members)}</s>;
    case 'code':
      return <code key={key} class="md-inline-code">{t.value}</code>;
    case 'codeblock':
      return <pre key={key} class="md-code-block"><code>{t.value}</code></pre>;
    case 'link':
      return (
        <a key={key} class="md-link" href={t.value} target="_blank" rel="noopener noreferrer">
          {t.value}
        </a>
      );
    case 'spoiler':
      return <Spoiler key={key} text={t.value} myNick={myNick} members={members} />;
    case 'emoji': {
      const char = emojiFor(t.value);
      // Unknown shortcode → render it literally so nothing is lost.
      return char
        ? <span key={key} class="md-emoji" role="img" aria-label={t.value}>{char}</span>
        : <span key={key}>{`:${t.value}:`}</span>;
    }
  }
}

// Click-to-reveal spoiler. Blurred until clicked (or Enter/Space focused).
function Spoiler({ text, myNick, members }: { text: string; myNick: string; members: { nick: string }[] }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      class={`md-spoiler ${revealed ? 'md-spoiler-revealed' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={revealed ? undefined : 'Spoiler, click to reveal'}
      onClick={() => setRevealed(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRevealed(true); } }}
    >
      {renderRichText(text, myNick, members)}
    </span>
  );
}

// Walk a plain-text fragment and emit colored spans for:
//   - Known-member nick mentions, with or without a leading @. We strip @ on
//     send, so the chat log usually contains bare nicks; we still highlight
//     them at word boundaries to keep the visual signal.
//   - Channel references (#foo / &foo).
//   - The viewer's own nick (mention-self class on top of the base styling).
export function renderRichText(
  text: string,
  myNick: string,
  members: { nick: string }[],
): preact.ComponentChildren {
  if (!text) return text;
  // lower(nick) → the nick as the member list spells it.
  const memberSet = new Map(members.map((m) => [m.nick.toLowerCase(), m.nick]));
  const out: preact.ComponentChildren[] = [];
  let last = 0;
  let key = 0;

  // Group 1: optional @ + nick chars (catches both "@alice" and bare "alice").
  // Group 2: #channel / &channel.
  // We require a word boundary before the match so substrings inside other
  // words don't get colored (e.g., "scalice" should not highlight "alice").
  const tokenRe = new RegExp(
    `(?<![${NICK_BOUNDARY_CHARS}])(@?[A-Za-z0-9_\\-\\[\\]\\\\{}|^\`]+)|(?<![${NICK_BOUNDARY_CHARS}])([#&][A-Za-z0-9_\\-\\[\\]\\\\{}|^\`]+)`,
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const tokenText = m[0];
    const word = m[1];
    const channel = m[2];

    let consumed = false;

    if (word) {
      const hasAt = word.startsWith('@');
      const candidate = (hasAt ? word.slice(1) : word).toLowerCase();
      if (memberSet.has(candidate)) {
        if (m.index > last) {
          out.push(<span key={key++}>{renderWithMentions(text.slice(last, m.index), myNick)}</span>);
        }
        // Our own nick is a member too — keep the self-mention highlight on it.
        const self = !!myNick && candidate === myNick.toLowerCase();
        // `ada:` / `ada,`: the pill sits flush against the punctuation.
        const flush = self && MENTION_FLUSH_RE.test(text.slice(m.index + tokenText.length));
        out.push(
          <span key={key++} class={self ? `chat-token-mention mention-self${flush ? ' mention-flush' : ''}` : 'chat-token-mention'} data-nick={memberSet.get(candidate)}>
            {tokenText}
          </span>,
        );
        last = m.index + tokenText.length;
        consumed = true;
      }
    } else if (channel) {
      if (m.index > last) {
        out.push(<span key={key++}>{renderWithMentions(text.slice(last, m.index), myNick)}</span>);
      }
      out.push(<span key={key++} class="chat-token-channel">{channel}</span>);
      last = m.index + channel.length;
      consumed = true;
    }

    // No-op match (plain word that isn't a known nick): let it fall through
    // to the trailing slice, which renders it as ordinary text with
    // self-mention highlighting applied.
    if (!consumed) continue;
  }
  if (last < text.length) {
    out.push(<span key={key++}>{renderWithMentions(text.slice(last), myNick)}</span>);
  }
  return out;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
