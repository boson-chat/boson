import type preact from 'preact';
import type { Ref } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal, memo } from 'preact/compat';
import type { Signal } from '@preact/signals';
import type { ChatMember, ChatMessage, MemberPrefix } from '../../modules/chat';
import { BarLoader } from '@boson/shared';
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
import { NickProfileCard, anchorOf, profileRows, useFitInWindow, type ProfileAnchor } from './nick-profile';
import { MessageSheet } from './MessageSheet';
import type { SheetAction } from './BottomSheet';
import { useLongPress } from './long-press';
import { isNarrow } from '../../shared/narrow';
import { buildNickContextActions, type NickActions } from './nick-actions';
import { resolveScrollTop, AT_BOTTOM_SLACK } from './scroll-resolve';

// Map IRC channel-status prefix to a short display label + a class name.
// Used both for the role pill rendered next to a nick in chat (MOD/OPS/V)
// and for color theming in the hover card. Centralised here so message
// rows and the member panel can't drift apart on label/color.
const ROLE_BADGES: Record<MemberPrefix, { label: string; kind: string } | null> = {
  '~': { label: 'FOUNDER', kind: 'founder' },
  '&': { label: 'ADMIN',   kind: 'admin' },
  '@': { label: 'OPS',     kind: 'op' },
  '%': { label: 'MOD',     kind: 'halfop' },
  '+': { label: 'V',       kind: 'voice' },
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
}

// Match UserPanel's hover-card open-delay so dwelling on a nick in chat
// and dwelling on one in the right rail feel identically responsive.
const HOVER_OPEN_DELAY_MS = 150;

export function MessageRow({ msg, myNick, members, grouped = false, nickActions, fresh = false, avatarFor, doc = false }: MessageRowProps) {
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

  const messageActions = (): SheetAction[] => {
    const theirs = msg.from !== myNick;
    const out: SheetAction[] = [];
    if (theirs && nickActions?.onMention) out.push({ label: 'Reply', onClick: () => nickActions.onMention!(msg.from) });
    out.push({ label: 'Copy text', onClick: () => { void navigator.clipboard?.writeText(stripIrcFormatting(msg.text)); } });
    if (theirs && nickActions?.onSendMessage) {
      out.push({ label: `Message ${msg.from}`, onClick: () => nickActions.onSendMessage!(msg.from) });
    }
    out.push({ label: 'View profile', onClick: () => setProfile({ nick: msg.from }) });
    return out;
  };
  const sheets = (
    <>
      {msgSheet && (
        <MessageSheet
          msg={msg}
          avatarUrl={avatarFor?.(msg.from)}
          actions={messageActions()}
          onClose={() => setMsgSheet(false)}
        />
      )}
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

  if (msg.kind === 'system' || msg.kind === 'join' || msg.kind === 'part' || msg.kind === 'quit') {
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
  const mentionsMe = !mine && containsNickMention(msg.text, myNick);
  const renderedText = doc ? null : renderMessageBody(msg.text, myNick, members);

  if (msg.kind === 'action') {
    return (
      <div class={`message-action ${mine ? 'message-action-mine' : ''} ${mentionsMe ? 'message-action-mention' : ''} ${fresh ? 'message-fresh' : ''}`} {...longPress}>
        <span class="message-action-star">*</span>
        <span class="message-action-name" onClick={(e) => openProfile(msg.from, e.currentTarget as Element)}>{msg.from}</span>
        <span class="message-action-text" onClick={onTextClick}>{renderedText}</span>
        <span class="message-row-time">{time}</span>
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
    <div class={classes} {...longPress}>
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
              <span class={`message-row-role message-row-role-${badge.kind}`} aria-label={`role: ${badge.label.toLowerCase()}`}>
                {badge.label}
              </span>
            )}
            <span class="message-row-handle">~{msg.from}</span>
            <span class="message-row-time">{msg.pending ? 'Sending…' : time}</span>
          </div>
        )}
        <div class={`message-row-text${doc ? ' message-row-doc' : ''}`} onClick={onTextClick}>
          {doc
            ? <MarkdownDoc text={msg.text} />
            : <span class="message-row-text-body">{renderedText}</span>}
          {grouped && <span class="message-row-grouped-time" aria-hidden={!msg.pending}>{msg.pending ? 'Sending…' : time}</span>}
        </div>
        {!doc && <MessageEmbeds text={msg.text} />}
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
  nick, member, top, left,
}: { nick: string; member: ChatMember | null; top: number; left: number }) {
  // Anchor the card just below the nick by default so it doesn't cover
  // the message text; above it when there's no room below.
  const CARD_WIDTH = 240;
  const cardTop = top + 24;
  const cardLeft = Math.max(8, Math.min(left, window.innerWidth - CARD_WIDTH - 8));
  const ref = useRef<HTMLDivElement>(null);
  useFitInWindow(ref, cardTop, top - 6);
  const role = ROLE_BADGES[member?.prefix ?? ''];
  const meta = profileRows(nick, member);
  return (
    <div
      ref={ref}
      class="nick-hovercard nick-hovercard-portal"
      role="tooltip"
      style={`top: ${cardTop}px; left: ${cardLeft}px; width: ${CARD_WIDTH}px;`}
    >
      <div class="nick-hovercard-head">
        <span class="nick-hovercard-nick">{nick}</span>
        {role && (
          <span class={`nick-hovercard-role nick-hovercard-role-${role.kind}`}>
            {role.label === 'V' ? 'Voiced' : role.label === 'OPS' ? 'Operator' : role.label === 'MOD' ? 'Half-op' : role.label === 'ADMIN' ? 'Admin' : 'Founder'}
          </span>
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
  historySupported?: boolean;
  historyLoading?: boolean;
  historyExhausted?: boolean;
  /** Set when a scroll-back request failed (e.g. no server response). Shown
   *  in the ribbon as a retryable error. */
  historyError?: string;
}

// Scroll container + message rows. Owns the grouped-rendering decision so
// the view doesn't need to know how messages stitch together visually.
//
// New-message entrance animation is gated by `freshnessBaseline`: messages
// whose timestamp postdates the most recent channel switch animate as
// they mount; everything older (history hydration, existing scrollback
// on channel switch, the initial batch on first render) is treated as
// already-present and renders without the slide-fade. This means the
// 500-message hydration of a long channel doesn't strobe — only genuine
// real-time arrivals do.
export const MessageList = memo(function MessageList({
  messages, members, myNick, scrollRef, nickActions, channelName, avatarFor,
  onLoadOlder, historySupported, historyLoading, historyExhausted, historyError,
}: MessageListProps) {
  // Reading `.value` subscribes THIS component to the channel's message signal.
  // A metadata emit that re-renders the parent passes the same signal ref, so
  // memo() bails — the list only re-renders when its messages actually change
  // (or a non-signal prop like members/history flags does).
  const msgs = messages.value;
  const freshnessBaseline = useRef<number>(Date.now());
  useEffect(() => {
    freshnessBaseline.current = Date.now();
  }, [channelName]);
  // Scroll management lives here (we own the scroll container) and re-runs
  // exactly when the message list changes — sticking to bottom on live appends,
  // preserving the viewport when older history is prepended, jumping to bottom
  // on channel switch. Unrelated re-renders (members/typing/history flags)
  // don't change `msgs`, so this effect doesn't run and won't yank the view.
  const scrollTrack = useRef({ name: channelName ?? undefined, count: 0, firstId: '', scrollHeight: 0 });
  // Live "is the viewport parked at the bottom?" flag, updated from real scroll
  // events (see onScroll). Defaults true so the first messages in a channel
  // stick before the user has scrolled at all. This is the source of truth for
  // sticking on live appends — measured from where the user actually is, so it
  // survives height drift between renders (embeds loading, cap trimming) that a
  // captured scrollHeight baseline could not.
  const atBottomRef = useRef(true);
  useEffect(() => {
    const el = (scrollRef as { current: HTMLDivElement | null }).current;
    if (!el) return;
    const firstId = msgs[0]?.id ?? '';
    const prev = scrollTrack.current;
    const target = resolveScrollTop(
      prev,
      { name: channelName ?? undefined, count: msgs.length, firstId },
      { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight },
      { atBottom: atBottomRef.current },
    );
    if (target !== null) {
      el.scrollTop = target;
      // Recompute stickiness from where we actually landed rather than
      // assuming the bottom. The stick-to-bottom and channel-switch paths
      // land at the bottom (→ true), but the prepended-history path restores
      // an interior position; claiming "at bottom" there would let the next
      // live PRIVMSG yank the viewport away from the older messages the user
      // just loaded — the same stale-stickiness bug this tracker fixes.
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK;
    }
    scrollTrack.current = { name: channelName ?? undefined, count: msgs.length, firstId, scrollHeight: el.scrollHeight };
  }, [msgs, channelName, scrollRef]);
  // Briefly confirm a completed load: flash "Loaded older messages" when a
  // request resolves (loading true→false with no error).
  const [justLoaded, setJustLoaded] = useState(false);
  const wasLoading = useRef(false);
  useEffect(() => {
    const was = wasLoading.current;
    wasLoading.current = !!historyLoading;
    if (was && !historyLoading && !historyError) {
      setJustLoaded(true);
      const t = setTimeout(() => setJustLoaded(false), 1800);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [historyLoading, historyError]);
  // Fire load-older only when the user has actually reached the top, and
  // debounce it: scroll events fire in bursts, so we wait for scrolling to
  // settle (and re-confirm we're still at the top) before pulling. This stops
  // a fling-to-top from queuing several pulls and keeps each scroll-to-top to
  // a single request. The in-flight / exhausted / error guards prevent repeats.
  const scrollDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (scrollDebounce.current) clearTimeout(scrollDebounce.current); }, []);
  const onScroll = (e: Event): void => {
    const el = e.currentTarget as HTMLDivElement;
    // Track bottom-stickiness on every scroll (including our own programmatic
    // scroll-to-bottom) — this must run regardless of the load-older guards
    // below, since it drives live-append autoscroll.
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK;
    if (!onLoadOlder || !historySupported || historyLoading || historyExhausted || historyError) return;
    if (scrollDebounce.current) clearTimeout(scrollDebounce.current);
    scrollDebounce.current = setTimeout(() => {
      scrollDebounce.current = null;
      // Re-check at fire time — state may have changed during the debounce, and
      // we only pull when genuinely parked at the very top (≤ 4px).
      if (historyLoading || historyExhausted || historyError) return;
      if (el.scrollTop <= 4) onLoadOlder();
    }, 250);
  };
  const items = buildRenderItems(msgs);
  // Track the previous *rendered chat message* for the grouping decision.
  // Reset across a collapsed activity block so a message that follows a
  // join/quit burst always starts a fresh group (the block is a visual
  // separator).
  let prevMsg: ChatMessage | null = null;
  return (
    <div class="chat-messages" ref={scrollRef} onScroll={onScroll}>
      <div class="messages-inner">
        {historySupported && (
          <div class="chat-load-older">
            {historyError ? (
              <button
                type="button"
                class="chat-load-older-btn chat-load-older-error"
                onClick={() => onLoadOlder?.()}
              >
                {historyError} — retry
              </button>
            ) : historyLoading ? (
              <>
                <BarLoader class="chat-load-older-bar" label="Loading older messages" />
                <span class="chat-load-older-loading">Loading older messages…</span>
              </>
            ) : justLoaded ? (
              <span class="chat-load-older-success">Loaded older messages</span>
            ) : historyExhausted ? (
              <span class="chat-load-older-end">Beginning of history</span>
            ) : (
              <button type="button" class="chat-load-older-btn" onClick={() => onLoadOlder?.()}>
                Load older messages
              </button>
            )}
          </div>
        )}
        {items.map((item) => {
          if (item.type === 'activity') {
            prevMsg = null;
            return <ActivityGroup key={item.id} items={item.items} />;
          }
          if (item.type === 'preblock') {
            prevMsg = null;
            return <PreBlock key={item.id} items={item.items} avatarFor={avatarFor} />;
          }
          const m = item.msg;
          const doc = item.type === 'doc';
          const grouped = shouldGroup(prevMsg, m);
          const isFresh = m.timestamp > freshnessBaseline.current;
          prevMsg = m;
          return (
            <MessageRow
              key={m.id}
              msg={m}
              myNick={myNick}
              members={members}
              grouped={grouped}
              nickActions={nickActions}
              fresh={isFresh}
              avatarFor={avatarFor}
              doc={doc}
            />
          );
        })}
      </div>
    </div>
  );
});

// Membership churn (join/part/quit) and repeated self-join system lines are
// noise that drowns real conversation — especially after reconnects or app
// restarts, where history replay can stack dozens of identical "You joined #x"
// lines. We fold consecutive runs of these into a single collapsible summary
// once a run gets long enough; short bursts (a couple of joins) still render
// inline so a quiet channel reads naturally.
const ACTIVITY_KINDS: ReadonlySet<ChatMessage['kind']> = new Set(['join', 'part', 'quit', 'system']);
// Runs shorter than this render inline (unchanged); this-or-longer collapse.
export const ACTIVITY_COLLAPSE_MIN = 4;

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
    if (activityRun.length >= collapseMin) {
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
    if (PREFORMAT_KINDS.has(m.kind) && !m.text.trim()) continue;
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
  const out: Array<{ text: string; count: number }> = [];
  for (const m of items) {
    const last = out[out.length - 1];
    if (last && last.text === m.text) last.count += 1;
    else out.push({ text: m.text, count: 1 });
  }
  return out;
}

// Collapsed summary for an activity run: a one-line teaser ("<first> · and N
// more") that expands on click into the full coalesced list.
function ActivityGroup({ items }: { items: ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const lines = coalesceActivity(items);
  const total = items.length;
  const first = lines[0]!;
  const firstLabel = first.count > 1 ? `${first.text} ×${first.count}` : first.text;
  const remaining = total - first.count;
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
          <span class="message-activity-summary">
            {firstLabel}{remaining > 0 ? ` · and ${remaining} more` : ''}
          </span>
        )}
      </button>
      {expanded && (
        <div class="message-activity-lines">
          {lines.map((l, i) => (
            <div key={i} class="message-system message-activity-line">
              <span class="sys-text">{l.text}{l.count > 1 ? ` ×${l.count}` : ''}</span>
            </div>
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
export function shouldGroup(prev: ChatMessage | null, curr: ChatMessage): boolean {
  if (!prev) return false;
  if (curr.kind !== 'message' && curr.kind !== 'notice') return false;
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
    out.push(<span class="mention-self">{m[0]}</span>);
    last = m.index + m[0].length;
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
          <span class="message-row-handle">~{head.from}</span>
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
        <button type="button" class="message-table-toggle" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '▾ Show less' : `▸ Show all ${table.rows.length} rows`}
        </button>
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
        out.push(
          <span key={key++} class={self ? 'chat-token-mention mention-self' : 'chat-token-mention'} data-nick={memberSet.get(candidate)}>
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
