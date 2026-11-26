import type { ChatMessage, ChatService } from '../../modules/chat';
import { OP } from '../../modules/chat';
import type { MessageActions } from './reactions';

export interface MessageActionsContext {
  /** The server relays client tags (message-tags): reactions. */
  reactions: boolean;
  /** The server offers draft/message-redaction: Delete. */
  redaction: boolean;
  myNick: string;
  /** Our services account; none (a guest) means no Delete. */
  myAccount?: string;
  /** Our rank in the conversation (channel-ops prefixRank); 0 in a DM. */
  myRank: number;
  isChannel: boolean;
}

// A conversation's reactions and Delete, bound to the chat service: absent
// where the server can't relay either (no message-tags, no
// draft/message-redaction). `typeof` guards keep hand-rolled test fakes
// working: they just get neither.
//
// Delete follows Ergo's deletionPolicy: signed in to an account (Ergo
// matches your own messages by account, and refuses guests); your own lines
// anywhere; in a channel where you're an operator (+o or higher; not
// half-op), anyone's. Server opers can delete anything, but the client can't
// tell reliably, so they get the channel-op rule like everyone else.
export function messageActionsFor(chat: ChatService, conversation: string, ctx: MessageActionsContext): MessageActions | undefined {
  if (typeof chat.reactionsSignal !== 'function' || (!ctx.reactions && !ctx.redaction)) return undefined;
  const isMine = (m: ChatMessage): boolean => !!ctx.myNick && m.from.toLowerCase() === ctx.myNick.toLowerCase();
  const deletable = (m: ChatMessage): boolean => m.kind === 'message' || m.kind === 'action' || m.kind === 'notice';
  return {
    canReact: (m) => ctx.reactions && !!m.msgid && m.kind !== 'system',
    react: (m, emoji, on) => chat.react(conversation, m, emoji, on),
    reactions: chat.reactionsSignal(conversation),
    canDelete: (m) => ctx.redaction && !!ctx.myAccount && !!m.msgid && deletable(m)
      && (isMine(m) || (ctx.isChannel && ctx.myRank >= OP)),
    remove: (m) => chat.redact(conversation, m),
  };
}
