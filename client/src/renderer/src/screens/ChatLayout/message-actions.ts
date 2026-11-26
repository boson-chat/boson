import type { ChatMessage, ChatService } from '../../modules/chat';
import type { MessageActions } from './reactions';

// A conversation's reactions and Delete, bound to the chat service: absent
// where the server can't relay either (no message-tags, no
// draft/message-redaction). `typeof` guards keep hand-rolled test fakes
// working: they just get neither.
export function messageActionsFor(
  chat: ChatService,
  conversation: string,
  reactions: boolean,
  redaction: boolean,
  myNick: string,
): MessageActions | undefined {
  if (typeof chat.reactionsSignal !== 'function' || (!reactions && !redaction)) return undefined;
  const isMine = (m: ChatMessage): boolean => !!myNick && m.from.toLowerCase() === myNick.toLowerCase();
  return {
    canReact: (m) => reactions && !!m.msgid && m.kind !== 'system',
    react: (m, emoji, on) => chat.react(conversation, m, emoji, on),
    reactions: chat.reactionsSignal(conversation),
    canDelete: (m) => redaction && !!m.msgid && isMine(m) && (m.kind === 'message' || m.kind === 'action' || m.kind === 'notice'),
    remove: (m) => chat.redact(conversation, m),
  };
}
