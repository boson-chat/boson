import type preact from 'preact';
import type { Ref } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal, memo } from 'preact/compat';
import type { Signal } from '@preact/signals';
import type { ChatMember, ChatMessage, MemberPrefix } from '../../modules/chat';
import { Avatar } from '../../shared/Avatar/Avatar';
import { tokenizeMarkdown, type MdToken } from './markdown';
import { NICK_BOUNDARY_CHARS } from './chat-input.tokenize';
import { NickContextMenu, type NickContextAction } from './NickContextMenu';
import type { NickActions } from './UserPanel';
import { resolveScrollTop } from './scroll-resolve';

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
}

// Match UserPanel's hover-card open-delay so dwelling on a nick in chat
// and dwelling on one in the right rail feel identically responsive.
const HOVER_OPEN_DELAY_MS = 150;

export function MessageRow({ msg, myNick, members, grouped = false, nickActions, fresh = false, avatarFor }: MessageRowProps) {
  const [menu, setMenu] = useState<{ nick: string; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ nick: string; top: number; left: number } | null>(null);
  // Debounce-on-enter timer for the hover card — see `UserPanel.tsx`.
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingOpen = () => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  function buildActions(nick: string): readonly NickContextAction[] {
    const out: NickContextAction[] = [
      { label: 'Copy nickname', onClick: () => { void navigator.clipboard?.writeText(nick); } },
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
  const renderedText = renderMessageBody(msg.text, myNick, members);

  if (msg.kind === 'action') {
    return (
      <div class={`message-action ${mine ? 'message-action-mine' : ''} ${mentionsMe ? 'message-action-mention' : ''} ${fresh ? 'message-fresh' : ''}`}>
        <span class="message-action-star">*</span>
        <span class="message-action-name">{msg.from}</span>
        <span class="message-action-text">{renderedText}</span>
        <span class="message-row-time">{time}</span>
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
  ].filter(Boolean).join(' ');

  const badge = ROLE_BADGES[findMemberPrefix(members, msg.from)];

  return (
    <div class={classes}>
      {/* Avatar gutter — the initial tile leads the first message of a group;
          grouped follow-ups keep the gutter empty so text stays aligned. */}
      <div class="message-row-gutter">
        {!grouped && (
          <Avatar nick={msg.from} url={avatarFor?.(msg.from)} size={30} class="message-avatar" />
        )}
      </div>
      <div class="message-row-body">
        {!grouped && (
          <div class="message-row-header">
            <span
              class="message-row-name"
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ nick: msg.from, x: e.clientX, y: e.clientY });
              }}
              onMouseEnter={(e) => {
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
            <span class="message-row-time">{time}</span>
          </div>
        )}
        <div class="message-row-text">
          <span class="message-row-text-body">{renderedText}</span>
          {grouped && <span class="message-row-grouped-time" aria-hidden="true">{time}</span>}
        </div>
      </div>
      {menu && (
        <NickContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.nick}
          actions={buildActions(menu.nick)}
          onClose={() => setMenu(null)}
        />
      )}
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
  // the message text. Clamp inside the viewport so it can't escape off
  // the top or bottom edge.
  const CARD_WIDTH = 240;
  const cardTop = Math.min(window.innerHeight - 16, top + 24);
  const cardLeft = Math.max(8, Math.min(left, window.innerWidth - CARD_WIDTH - 8));
  const role = ROLE_BADGES[member?.prefix ?? ''];
  const meta: { label: string; value: string }[] = [];
  if (member?.account) meta.push({ label: 'Account', value: member.account });
  if (member?.hostname) meta.push({ label: 'Host', value: member.hostname });
  if (member?.realname) meta.push({ label: 'Real name', value: member.realname });
  if (member?.awayMessage) meta.push({ label: 'Away', value: member.awayMessage });
  return (
    <div
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
  useEffect(() => {
    const el = (scrollRef as { current: HTMLDivElement | null }).current;
    if (!el) return;
    const firstId = msgs[0]?.id ?? '';
    const prev = scrollTrack.current;
    const target = resolveScrollTop(
      prev,
      { name: channelName ?? undefined, count: msgs.length, firstId },
      { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight },
    );
    if (target !== null) el.scrollTop = target;
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
    if (!onLoadOlder || !historySupported || historyLoading || historyExhausted || historyError) return;
    const el = e.currentTarget as HTMLDivElement;
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
              <span class="chat-load-older-loading">Loading older messages…</span>
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
          const m = item.msg;
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
  | { type: 'activity'; id: string; items: ChatMessage[] };

// Walk the message list and fold long consecutive runs of activity-kind
// messages into a single `activity` item. Everything else (and short runs)
// passes through as individual `msg` items, preserving the existing
// per-message rendering + grouping.
export function buildRenderItems(
  messages: readonly ChatMessage[],
  collapseMin: number = ACTIVITY_COLLAPSE_MIN,
): RenderItem[] {
  const out: RenderItem[] = [];
  let run: ChatMessage[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= collapseMin) {
      out.push({ type: 'activity', id: `activity-${run[0]!.id}`, items: run });
    } else {
      for (const m of run) out.push({ type: 'msg', msg: m });
    }
    run = [];
  };
  for (const m of messages) {
    if (ACTIVITY_KINDS.has(m.kind)) {
      run.push(m);
    } else {
      flush();
      out.push({ type: 'msg', msg: m });
    }
  }
  flush();
  return out;
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
export function renderMessageBody(
  text: string,
  myNick: string,
  members: { nick: string }[],
): preact.ComponentChildren {
  const tokens = tokenizeMarkdown(text);
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
  }
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
  const memberSet = new Set(members.map((m) => m.nick.toLowerCase()));
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
        out.push(<span key={key++} class="chat-token-mention">{tokenText}</span>);
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
