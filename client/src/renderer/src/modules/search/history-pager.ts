// history-pager.ts — the full-page search's own walk back through a
// conversation's server history.
//
// Search looks at what's loaded first. "Older results" then fetches the next
// batch (BATCH_SIZE messages, in requests of the server's CHATHISTORY
// maximum) older than the oldest point fetched so far, and keeps it here, in
// memory for the session: a new query searches it again without asking the
// server. None of it goes into the conversation unless the user opens a
// result there (ChatService.revealHistory).
//
// States: idle (more may be fetched) → loading → idle | end (the server has
// nothing older) | error (retry from where it stopped). Without CHATHISTORY
// on the connection: unsupported (search only what's loaded).
import type { ChatMessage } from '../chat/chat.types';
import { lineIdentity } from '../history/older-store';

/** Messages one "Older results" fetches. */
export const BATCH_SIZE = 500;

export type PagerStatus = 'idle' | 'loading' | 'end' | 'error' | 'unsupported';

export interface HistorySource {
  /** The connection offers CHATHISTORY. */
  supported(): boolean;
  /** The most one request may ask for. */
  chunkLimit(): number;
  /**
   * Up to `limit` messages older than `beforeMs` (server time), oldest
   * first. `received` / `oldest`, when given: how many items the server
   * sent and the oldest one's server time — events (joins, quits, TAGMSGs)
   * count toward the page and move the cursor without being lines.
   */
  fetchBefore(beforeMs: number, limit: number): Promise<ChatMessage[] & { received?: number; oldest?: number }>;
}

export interface PagerState {
  status: PagerStatus;
  error: string | null;
  /** Fetched lines, oldest first. */
  lines: readonly ChatMessage[];
  /** The oldest point fetched (server time, ms); null before the first fetch. */
  cursor: number | null;
}

// A line's time as the server stamped it (what CHATHISTORY pages by).
export function serverTimeOf(m: ChatMessage): number {
  return m.serverTime ?? m.timestamp;
}

export class HistoryPager {
  private state: PagerState = { status: 'idle', error: null, lines: [], cursor: null };
  private readonly ids = new Set<string>();
  private readonly listeners = new Set<(s: PagerState) => void>();

  constructor(private readonly batchSize = BATCH_SIZE) {}

  getState(): PagerState {
    return this.state;
  }

  subscribe(fn: (s: PagerState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** The status, given whether the connection has CHATHISTORY now. */
  statusWith(source: HistorySource | null): PagerStatus {
    const s = this.state.status;
    if ((s === 'idle' || s === 'error') && !source?.supported()) return 'unsupported';
    return s;
  }

  /**
   * Fetch the next batch older than the cursor — the first time, older than
   * `start` (the oldest line loaded in the conversation; now when nothing
   * is). A no-op while a fetch is in flight or once the history has ended.
   */
  async loadOlder(source: HistorySource, start: number | null): Promise<void> {
    const s = this.state.status;
    if (s === 'loading' || s === 'end') return;
    if (!source.supported()) { this.set({ status: 'unsupported', error: null }); return; }
    let cursor = this.state.cursor ?? start ?? Date.now();
    this.set({ status: 'loading', error: null });
    try {
      let got = 0;
      let ended = false;
      while (got < this.batchSize) {
        const want = Math.max(1, Math.min(source.chunkLimit(), this.batchSize - got));
        const page = await source.fetchBefore(cursor, want);
        // Nothing older (a short page is followed by one more request: a
        // server may cap pages below what was asked).
        const received = Math.max(page.length, page.received ?? 0);
        if (received === 0) { ended = true; break; }
        got += received;
        const oldest = Math.min(page.oldest ?? Infinity, ...page.map(serverTimeOf));
        // A server that ignored BEFORE would loop forever.
        if (oldest >= cursor) { ended = true; break; }
        cursor = oldest;
        this.add(page, cursor);
      }
      this.set({ status: ended ? 'end' : 'idle', error: null });
    } catch (e) {
      this.set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private add(page: readonly ChatMessage[], cursor: number): void {
    const fresh: ChatMessage[] = [];
    for (const m of page) {
      const id = lineIdentity(m);
      if (this.ids.has(id)) continue;
      this.ids.add(id);
      fresh.push(m);
    }
    const lines = fresh.length > 0
      ? [...fresh, ...this.state.lines].sort((a, b) => a.timestamp - b.timestamp)
      : this.state.lines;
    this.set({ lines, cursor });
  }

  private set(patch: Partial<PagerState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
}
