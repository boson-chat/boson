import type { ChatMessage } from '../../modules/chat';
import { Avatar } from '../../shared/Avatar/Avatar';
import { BottomSheet, type SheetAction } from './BottomSheet';
import { stripIrcFormatting } from './markdown';
import './MessageSheet.css';

interface MessageSheetProps {
  msg: ChatMessage;
  avatarUrl?: string;
  actions: readonly SheetAction[];
  onClose: () => void;
}

// Phone layout: a long press on a message opens this instead of starting a
// text selection — the message it's about, then what you can do with it.
export function MessageSheet({ msg, avatarUrl, actions, onClose }: MessageSheetProps) {
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <BottomSheet
      label={`Message from ${msg.from}`}
      actions={actions}
      onClose={onClose}
      header={
        <div class="message-sheet-head">
          <Avatar nick={msg.from} url={avatarUrl} size={28} />
          <span class="message-sheet-nick">{msg.from}</span>
          <span class="message-sheet-time">{time}</span>
        </div>
      }
    >
      <p class="message-sheet-text">{stripIrcFormatting(msg.text)}</p>
    </BottomSheet>
  );
}
