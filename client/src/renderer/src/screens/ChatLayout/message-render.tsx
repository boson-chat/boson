import type preact from 'preact';
import type { Ref } from 'preact';
import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ChatMember, ChatMessage, MemberPrefix } from '../../modules/chat';
import { tokenizeMarkdown, type MdToken } from './markdown';
import { NICK_BOUNDARY_CHARS } from './chat-input.tokenize';
import { NickContextMenu, type NickContextAction } from './NickContextMenu';
import type { NickActions } from './UserPanel';

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
}

export function MessageRow({ msg, myNick, members, grouped = false, nickActions }: MessageRowProps) {
  const [menu, setMenu] = useState<{ nick: string; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ nick: string; top: number; left: number } | null>(null);

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
      <div class={`message-system message-system-${msg.kind}`}>
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
      <div class={`message-action ${mine ? 'message-action-mine' : ''} ${mentionsMe ? 'message-action-mention' : ''}`}>
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
  ].filter(Boolean).join(' ');

  const badge = ROLE_BADGES[findMemberPrefix(members, msg.from)];

  return (
    <div class={classes}>
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
              setHover({ nick: msg.from, top: r.top, left: r.left });
            }}
            onMouseLeave={() => {
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
  messages: readonly ChatMessage[];
  members: ChatMember[];
  myNick: string;
  scrollRef: Ref<HTMLDivElement>;
  nickActions?: NickActions;
}

// Scroll container + message rows. Owns the grouped-rendering decision so
// the view doesn't need to know how messages stitch together visually.
export function MessageList({ messages, members, myNick, scrollRef, nickActions }: MessageListProps) {
  return (
    <div class="chat-messages" ref={scrollRef}>
      <div class="messages-inner">
        {messages.map((m, idx) => {
          const prev = idx > 0 ? messages[idx - 1]! : null;
          const grouped = shouldGroup(prev, m);
          return (
            <MessageRow
              key={m.id}
              msg={m}
              myNick={myNick}
              members={members}
              grouped={grouped}
              nickActions={nickActions}
            />
          );
        })}
      </div>
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
