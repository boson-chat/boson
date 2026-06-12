// Tiny in-process intent bus for "open this Inbox entry's conversation".
//
// The Inbox is rendered up in AppShell, but navigation (switch server, open a
// DM) lives in the DirectoryBloc down inside DirectoryScreen. Rather than lift
// the bloc or thread a callback through the tree, the Inbox publishes an
// intent here and DirectoryScreen subscribes — same decoupling the deep-link
// module uses for join intents.

export interface OpenConversationIntent {
  // Server connection the entry came from (memo.serverId).
  serverId: string;
  // Conversation to open within that server: the sender's nick for a DM, or
  // null to just focus the server (service notices / memos have no 1:1 tab).
  target: string | null;
}

type Listener = (intent: OpenConversationIntent) => void;

const listeners = new Set<Listener>();

export function publishOpenConversation(intent: OpenConversationIntent): void {
  for (const fn of listeners) {
    try { fn(intent); } catch { /* isolate — one bad subscriber can't block others */ }
  }
}

export function subscribeOpenConversation(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Sibling intent: "fetch this memo's body". The Inbox knows the
// (serverId, memoIndex); the actual READ <n> is issued by the server's
// ChatService, reached via DirectoryBloc — same decoupling as above.
export interface ReadMemoIntent {
  serverId: string;
  memoIndex: number;
}

type ReadMemoListener = (intent: ReadMemoIntent) => void;

const readMemoListeners = new Set<ReadMemoListener>();

export function publishReadMemo(intent: ReadMemoIntent): void {
  for (const fn of readMemoListeners) {
    try { fn(intent); } catch { /* isolate */ }
  }
}

export function subscribeReadMemo(fn: ReadMemoListener): () => void {
  readMemoListeners.add(fn);
  return () => { readMemoListeners.delete(fn); };
}
