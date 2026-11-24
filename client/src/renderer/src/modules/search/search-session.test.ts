import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/chat.types';
import { clearSearchSessions, conversationSearch, historySource, revealResult, type SearchChat } from './search-session';

const m = (i: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `f${i}`, kind: 'message', from: 'kestrel', text: `line ${i}`, timestamp: 1_000 + i, msgid: `id${i}`, ...extra });

function fakeChat(opts: { shown?: ChatMessage[]; history?: boolean; around?: 'ok' | 'fail' } = {}) {
  const shown = [...(opts.shown ?? [])];
  const revealed: ChatMessage[][] = [];
  const fetches: string[] = [];
  const chat: SearchChat = {
    chathistorySupported: () => opts.history ?? true,
    historyQueryLimit: () => 100,
    fetchHistory: vi.fn(async (target, sub, ref, limit) => {
      fetches.push(`${sub} ${target} ${'msgid' in ref ? `msgid=${ref.msgid}` : `ts=${ref.timestamp}`} ${limit}`);
      if (sub === 'AROUND' && opts.around === 'fail') throw new Error('FAIL');
      return [m(500), m(501), m(502)];
    }),
    revealHistory: vi.fn((_c, msgs, focus) => {
      revealed.push([...msgs]);
      for (const x of msgs) if (!shown.some((s) => s.msgid === x.msgid)) shown.push({ ...x, id: `c-${x.msgid}` });
      return shown.find((s) => s.id === focus.id || s.msgid === focus.msgid)?.id ?? null;
    }),
  };
  return { chat, shown, revealed, fetches };
}

describe('conversationSearch', () => {
  it('one per conversation and server (any case), kept until sign-out', () => {
    const a = conversationSearch('s1', '#Dev');
    a.save({ query: 'dns', scrollTop: 420, selectedId: 'm9' });
    expect(conversationSearch('s1', '#dev')).toBe(a);
    expect(conversationSearch('s2', '#dev')).not.toBe(a);
    // Back to results: the same query, scroll and pick.
    expect(conversationSearch('s1', '#dev').ui).toMatchObject({ query: 'dns', scrollTop: 420, selectedId: 'm9', from: null, hasLink: false });
    clearSearchSessions();
    expect(conversationSearch('s1', '#dev')).not.toBe(a);
    expect(conversationSearch('s1', '#dev').ui.query).toBe('');
  });
});

describe('historySource', () => {
  it('asks the chat for CHATHISTORY BEFORE a time, at its limit', async () => {
    const { chat, fetches } = fakeChat();
    const src = historySource(chat, '#dev');
    expect(src.supported()).toBe(true);
    expect(src.chunkLimit()).toBe(100);
    await src.fetchBefore(5_000, 100);
    expect(fetches).toEqual(['BEFORE #dev ts=5000 100']);
  });
});

describe('revealResult', () => {
  it('a result already in the conversation: just its id, nothing fetched', async () => {
    const live = m(1, { id: 'live1' });
    const { chat, fetches } = fakeChat({ shown: [live] });
    expect(await revealResult(chat, '#dev', [], live)).toBe('live1');
    expect(fetches).toEqual([]);
  });

  it('a fetched result brings the fetched lines from a little before it to the newest', async () => {
    const fetched = Array.from({ length: 100 }, (_, i) => m(i));
    const { chat, revealed, fetches } = fakeChat();
    const id = await revealResult(chat, '#dev', fetched, fetched[50]!);
    expect(id).toBe('c-id50');
    expect(revealed[0]![0]!.msgid).toBe('id20');
    expect(revealed[0]!.at(-1)!.msgid).toBe('id99');
    expect(fetches).toEqual([]);
  });

  it('anywhere else: CHATHISTORY AROUND its msgid', async () => {
    const lost = m(501);
    const { chat, fetches } = fakeChat();
    expect(await revealResult(chat, '#dev', [], lost)).toBe('c-id501');
    expect(fetches).toEqual(['AROUND #dev msgid=id501 50']);
  });

  it('no AROUND on the server: what came before it, then it', async () => {
    const lost = m(777, { serverTime: 9_000 });
    const { chat, fetches } = fakeChat({ around: 'fail' });
    expect(await revealResult(chat, '#dev', [], lost)).toBe('c-id777');
    expect(fetches).toEqual(['AROUND #dev msgid=id777 50', 'BEFORE #dev ts=9001 30']);
  });

  it('without CHATHISTORY: null when it is not shown', async () => {
    const { chat } = fakeChat({ history: false });
    const r = await revealResult(chat, '#dev', [], m(1));
    expect(r).toBeNull();
  });
});
