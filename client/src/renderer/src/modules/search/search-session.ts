// search-session.ts — one conversation's search, kept for the app session:
// what was asked (query, filters), where the results list was scrolled and
// which result was picked — so "Back to results" (after opening one in the
// conversation) comes back to the same page — and the history fetched for
// it (HistoryPager), reused by every later query. In memory only; cleared on
// sign-out.
import type { ChatMessage } from '../chat/chat.types';
import { HistoryPager, type HistorySource } from './history-pager';

export interface SearchUiState {
  query: string;
  from: string | null;
  hasLink: boolean;
  /** The results list's scroll position. */
  scrollTop: number;
  /** The picked result (a message id). */
  selectedId: string | null;
}

export const INITIAL_UI: SearchUiState = { query: '', from: null, hasLink: false, scrollTop: 0, selectedId: null };

export class ConversationSearch {
  ui: SearchUiState = { ...INITIAL_UI };
  readonly pager = new HistoryPager();

  save(patch: Partial<SearchUiState>): void {
    this.ui = { ...this.ui, ...patch };
  }
}

const sessions = new Map<string, ConversationSearch>();

function keyOf(serverId: string, conversation: string): string {
  return `${serverId}\0${conversation.toLowerCase()}`;
}

/** The search of a conversation on a server (made on first use). */
export function conversationSearch(serverId: string, conversation: string): ConversationSearch {
  const key = keyOf(serverId, conversation);
  let s = sessions.get(key);
  if (!s) { s = new ConversationSearch(); sessions.set(key, s); }
  return s;
}

/** Sign-out: forget every query and every fetched line. */
export function clearSearchSessions(): void {
  sessions.clear();
}

/** What a ChatService offers search (ChatService itself fits). */
export interface SearchChat {
  chathistorySupported(): boolean;
  historyQueryLimit(): number;
  fetchHistory(target: string, sub: 'BEFORE' | 'AROUND', ref: { msgid: string } | { timestamp: number }, limit: number): Promise<ChatMessage[]>;
  revealHistory(channel: string, msgs: readonly ChatMessage[], focus: ChatMessage): string | null;
}

/** A conversation's server history, as the pager asks for it. */
export function historySource(chat: SearchChat, target: string): HistorySource {
  return {
    supported: () => chat.chathistorySupported(),
    chunkLimit: () => chat.historyQueryLimit(),
    fetchBefore: (beforeMs, limit) => chat.fetchHistory(target, 'BEFORE', { timestamp: beforeMs }, limit),
  };
}

// Lines either side of a result put into the conversation with it.
const REVEAL_BEFORE = 30;
const AROUND_LIMIT = 50;

/**
 * Open a result in its conversation: make sure it — and what's around it —
 * is there, and return the conversation's id for it (to scroll to). A result
 * from fetched history brings every fetched line from a little before it up
 * to where the conversation's own lines start (so there's no gap); one that
 * isn't anywhere loaded is fetched with CHATHISTORY AROUND.
 */
export async function revealResult(
  chat: SearchChat,
  conversation: string,
  fetched: readonly ChatMessage[],
  result: ChatMessage,
): Promise<string | null> {
  const at = fetched.indexOf(result);
  if (at >= 0) {
    const id = chat.revealHistory(conversation, fetched.slice(Math.max(0, at - REVEAL_BEFORE)), result);
    if (id) return id;
  } else {
    const id = chat.revealHistory(conversation, [], result);
    if (id) return id;
  }
  if (!chat.chathistorySupported()) return null;
  const at2 = result.serverTime ?? result.timestamp;
  let around: ChatMessage[];
  try {
    around = await chat.fetchHistory(conversation, 'AROUND', result.msgid ? { msgid: result.msgid } : { timestamp: at2 }, AROUND_LIMIT);
  } catch {
    // No AROUND on this server: what came before it, then it.
    around = await chat.fetchHistory(conversation, 'BEFORE', { timestamp: at2 + 1 }, REVEAL_BEFORE);
  }
  return chat.revealHistory(conversation, [...around, result], result);
}
