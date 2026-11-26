import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/chat.types';
import { HistoryPager, type HistorySource } from './history-pager';
import { mergeLines, search, EMPTY_FILTERS } from './search-match';

// A server keeping `total` lines, one a minute, the newest at T_END.
const T_END = Date.parse('2026-11-24T00:00:00Z');
function server(total: number, opts: { max?: number; cap?: number } = {}) {
  const lines: ChatMessage[] = Array.from({ length: total }, (_, i) => ({
    id: `s${i}`, kind: 'message', from: i % 2 ? 'kestrel' : 'mox', text: i % 10 === 0 ? `dns line ${i}` : `line ${i}`,
    timestamp: T_END - (total - i) * 60_000, msgid: `id${i}`,
  }));
  const calls: Array<{ before: number; limit: number }> = [];
  let fail: Error | null = null;
  let supported = true;
  const source: HistorySource = {
    supported: () => supported,
    chunkLimit: () => opts.max ?? 100,
    fetchBefore: vi.fn(async (before: number, limit: number) => {
      calls.push({ before, limit });
      if (fail) throw fail;
      const older = lines.filter((l) => l.timestamp < before);
      // A server may answer with fewer than asked (its own cap).
      return older.slice(-Math.min(limit, opts.cap ?? limit)).map((m) => ({ ...m }));
    }),
  };
  return {
    lines, calls, source,
    fail: (e: Error | null) => { fail = e; },
    unsupported: () => { supported = false; },
  };
}

describe('HistoryPager', () => {
  it('fetches the next 500 older than the oldest loaded line, in requests of the server maximum', async () => {
    const s = server(1200, { max: 100 });
    const p = new HistoryPager();
    const start = s.lines[1100]!.timestamp; // the oldest line the conversation has
    await p.loadOlder(s.source, start);
    expect(s.calls).toHaveLength(5);
    expect(s.calls.every((c) => c.limit === 100)).toBe(true);
    expect(s.calls[0]!.before).toBe(start);
    // Each request continues from the oldest line the previous one brought.
    for (let i = 1; i < s.calls.length; i++) expect(s.calls[i]!.before).toBeLessThan(s.calls[i - 1]!.before);
    const st = p.getState();
    expect(st.status).toBe('idle');
    expect(st.lines).toHaveLength(500);
    expect(st.lines[0]!.msgid).toBe('id600');
    expect(st.cursor).toBe(s.lines[600]!.timestamp);
  });

  it('asks for at most the batch when the server allows more per request', async () => {
    const s = server(2000, { max: 1000 });
    const p = new HistoryPager();
    await p.loadOlder(s.source, T_END);
    expect(s.calls.map((c) => c.limit)).toEqual([500]);
  });

  it('picks up where it stopped: the cursor moves back a batch at a time', async () => {
    const s = server(1200, { max: 250 });
    const p = new HistoryPager();
    await p.loadOlder(s.source, T_END);
    const first = p.getState().cursor!;
    await p.loadOlder(s.source, T_END);
    expect(s.calls[2]!.before).toBe(first);
    expect(p.getState().lines).toHaveLength(1000);
  });

  it('ends when the server has nothing older (a short page is checked once more)', async () => {
    const s = server(620, { max: 100 });
    const p = new HistoryPager();
    await p.loadOlder(s.source, T_END);
    expect(p.getState().status).toBe('idle');
    await p.loadOlder(s.source, T_END);
    expect(p.getState().status).toBe('end');
    expect(p.getState().lines).toHaveLength(620);
    // 100 → then 20 (short) → then an empty page.
    expect(s.calls.slice(5).map((c) => c.limit)).toEqual([100, 100, 100]);
    const before = s.calls.length;
    await p.loadOlder(s.source, T_END);
    expect(s.calls.length).toBe(before); // no more requests once ended
  });

  it('a server capping pages below its stated maximum is not taken for the end', async () => {
    const s = server(400, { max: 100, cap: 50 });
    const p = new HistoryPager();
    await p.loadOlder(s.source, T_END);
    expect(p.getState().lines).toHaveLength(400);
    expect(p.getState().status).toBe('end');
  });

  it('without CHATHISTORY: unsupported, nothing asked', async () => {
    const s = server(100);
    s.unsupported();
    const p = new HistoryPager();
    expect(p.statusWith(s.source)).toBe('unsupported');
    expect(p.statusWith(null)).toBe('unsupported');
    await p.loadOlder(s.source, T_END);
    expect(s.calls).toHaveLength(0);
    expect(p.getState().status).toBe('unsupported');
  });

  it('an error stops the fetch, keeps what came, and a retry continues from there', async () => {
    const s = server(1200, { max: 100 });
    const p = new HistoryPager();
    let n = 0;
    const flaky: HistorySource = {
      ...s.source,
      fetchBefore: (b, l) => (++n === 3 ? Promise.reject(new Error('No response from server')) : s.source.fetchBefore(b, l)),
    };
    await p.loadOlder(flaky, T_END);
    expect(p.getState().status).toBe('error');
    expect(p.getState().error).toBe('No response from server');
    expect(p.getState().lines).toHaveLength(200);
    const cursor = p.getState().cursor;
    await p.loadOlder(flaky, T_END);
    expect(p.getState().status).toBe('idle');
    expect(s.calls.at(-5)!.before).toBe(cursor);
    expect(p.getState().lines).toHaveLength(700);
  });

  it('one fetch at a time: a second ask while loading does nothing', async () => {
    const s = server(1200, { max: 500 });
    const p = new HistoryPager();
    const states: string[] = [];
    p.subscribe((st) => states.push(st.status));
    const a = p.loadOlder(s.source, T_END);
    expect(p.getState().status).toBe('loading');
    const b = p.loadOlder(s.source, T_END);
    await Promise.all([a, b]);
    expect(s.calls).toHaveLength(1);
    expect(states[0]).toBe('loading');
    expect(states.at(-1)).toBe('idle');
  });

  it('keeps what it fetched: a new query searches it again without asking the server', async () => {
    const s = server(1200, { max: 500 });
    const p = new HistoryPager();
    await p.loadOlder(s.source, T_END);
    const asked = s.calls.length;
    const dns = search(mergeLines([], p.getState().lines), { ...EMPTY_FILTERS, text: 'dns' });
    const mox = search(mergeLines([], p.getState().lines), { ...EMPTY_FILTERS, from: 'mox' });
    expect(dns).toHaveLength(50);
    expect(mox).toHaveLength(250);
    expect(s.calls.length).toBe(asked);
  });

  it('pages by the server\'s own time (serverTime), not the corrected one', async () => {
    const calls: number[] = [];
    const p = new HistoryPager();
    const src: HistorySource = {
      supported: () => true,
      chunkLimit: () => 2,
      fetchBefore: async (before) => {
        calls.push(before);
        return calls.length === 1
          ? [{ id: 'a', kind: 'message', from: 'x', text: 'a', timestamp: 5_000, serverTime: 1_000 }]
          : [];
      },
    };
    await p.loadOlder(src, 10_000);
    expect(calls).toEqual([10_000, 1_000]);
  });

  it('a page that is all events (joins, quits, TAGMSGs) moves the cursor and is not the end', async () => {
    const calls: number[] = [];
    const source: HistorySource = {
      supported: () => true,
      chunkLimit: () => 100,
      fetchBefore: vi.fn(async (before: number) => {
        calls.push(before);
        // First page: 100 events, no lines; then one line; then nothing.
        if (calls.length === 1) return Object.assign([] as ChatMessage[], { received: 100, oldest: before - 100_000 });
        if (calls.length === 2) return [{ id: 'x', kind: 'message', from: 'mox', text: 'old dns', timestamp: before - 1000 }] as ChatMessage[];
        return [];
      }),
    };
    const p = new HistoryPager();
    await p.loadOlder(source, T_END);
    expect(calls[0]).toBe(T_END);
    expect(calls[1]).toBe(T_END - 100_000); // continues past the events, not the same page again
    expect(p.getState().lines.map((l) => l.id)).toEqual(['x']);
    expect(p.getState().status).toBe('end');
  });
});

