import type preact from 'preact';
import type { Ref } from 'preact';
import type { ChatMessage } from '../../modules/chat';
import { tokenizeMarkdown, type MdToken } from './markdown';
import { NICK_BOUNDARY_CHARS } from './chat-input.tokenize';

interface MessageRowProps {
  msg: ChatMessage;
  myNick: string;
  members: { nick: string }[];
  grouped?: boolean;
}

export function MessageRow({ msg, myNick, members, grouped = false }: MessageRowProps) {
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

  return (
    <div class={classes}>
      {!grouped && (
        <div class="message-row-header">
          <span class="message-row-name">{msg.from}</span>
          <span class="message-row-handle">~{msg.from}</span>
          <span class="message-row-time">{time}</span>
        </div>
      )}
      <div class="message-row-text">
        <span class="message-row-text-body">{renderedText}</span>
        {grouped && <span class="message-row-grouped-time" aria-hidden="true">{time}</span>}
      </div>
    </div>
  );
}

interface MessageListProps {
  messages: readonly ChatMessage[];
  members: { nick: string }[];
  myNick: string;
  scrollRef: Ref<HTMLDivElement>;
}

// Scroll container + message rows. Owns the grouped-rendering decision so
// the view doesn't need to know how messages stitch together visually.
export function MessageList({ messages, members, myNick, scrollRef }: MessageListProps) {
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
