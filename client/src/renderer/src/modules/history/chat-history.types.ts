// chat-history.types.ts — public surface for the per-channel chat-history
// stores. Two implementations exist:
//   • IDBChatHistoryStore (production, IndexedDB-backed)
//   • MemoryChatHistoryStore (tests + fallback when IDB is unavailable)
//
// HistoryScope partitions storage by (userId, serverId, channel) so two
// signed-in users on the same machine, or the same user across different
// servers, never see each other's logs.

import type { ChatMessage } from '../chat/chat.types';

export type { ChatMessage };

export interface HistoryScope {
  userId: string;       // Supabase auth user id
  serverId: string;     // server.id from the directory (UUID) — stable
  channel: string;      // already lowercased channel key (matches ChatService.channelKey())
}

export interface ChatHistoryStore {
  load(scope: HistoryScope): Promise<ChatMessage[]>;
  append(scope: HistoryScope, msg: ChatMessage): Promise<void>;
  clear(scope: HistoryScope): Promise<void>;
  wipeAllForUser(userId: string): Promise<void>; // used on sign-out
}

// Stored per-channel cap. We keep the LAST_N most-recent messages; older ones
// are evicted on each append. Tuned for chat scrollback: large enough to feel
// "everything's still there" on relaunch, small enough that a noisy channel
// can't blow up IDB.
export const HISTORY_CAP = 500;
