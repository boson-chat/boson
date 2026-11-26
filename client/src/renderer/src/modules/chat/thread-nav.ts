// "Open the thread this message is in": a notification (a toast, the
// bell's list, a system banner) for a reply goes to its conversation, and
// ChatLayout then opens the message's thread (threads.ts) once the
// conversation and the message are there.

import { signal } from '@preact/signals';

export interface ThreadIntent {
  serverId: string;
  channel: string;
  /** The message's local id, and its msgid (either finds it). */
  messageId?: string;
  msgid?: string;
  /** When asked: an intent nobody could carry out goes stale. */
  at: number;
}

/** How long an intent waits for its conversation and message. */
export const THREAD_INTENT_TTL_MS = 30_000;

export const pendingThread = signal<ThreadIntent | null>(null);

export function requestThread(i: Omit<ThreadIntent, 'at'>): void {
  if (!i.messageId && !i.msgid) return;
  pendingThread.value = { ...i, at: Date.now() };
}
