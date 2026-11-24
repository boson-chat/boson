import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat/chat.types';
import {
  authorsOf, contextOf, dayLabel, groupByDay, hasLink, highlightParts, isActive, matches, mergeLines, search,
  EMPTY_FILTERS, type SearchFilters,
} from './search-match';

const T0 = Date.parse('2026-11-20T12:00:00Z');
let n = 0;
const msg = (from: string, text: string, at = T0 + n * 1000, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m${++n}`, kind: 'message', from, text, timestamp: at, ...extra });
const f = (p: Partial<SearchFilters>): SearchFilters => ({ ...EMPTY_FILTERS, ...p });

describe('matching', () => {
  it('finds the text in any case, ignoring IRC formatting', () => {
    expect(matches(msg('a', 'the DNS record'), f({ text: 'dns' }))).toBe(true);
    expect(matches(msg('a', 'the \x02D\x02NS record'), f({ text: 'dns' }))).toBe(true);
    expect(matches(msg('a', 'nothing here'), f({ text: 'dns' }))).toBe(false);
    expect(matches(msg('a', 'dns'), f({ text: '  dns  ' }))).toBe(true);
  });

  it('only counts what people said: messages and /me, not joins, parts, notices or system lines', () => {
    const text = 'dns';
    expect(matches(msg('a', 'dns', T0, { kind: 'action' }), f({ text }))).toBe(true);
    for (const kind of ['join', 'part', 'quit', 'kick', 'system', 'notice'] as const) {
      expect(matches(msg('a', 'dns', T0, { kind }), f({ text }))).toBe(false);
    }
  });

  it('From: only that nick (any case)', () => {
    expect(matches(msg('Kestrel', 'dns'), f({ text: 'dns', from: 'kestrel' }))).toBe(true);
    expect(matches(msg('mox', 'dns'), f({ text: 'dns', from: 'kestrel' }))).toBe(false);
    // With no text, everything they said.
    expect(matches(msg('kestrel', 'hello'), f({ from: 'kestrel' }))).toBe(true);
  });

  it('Has link: only lines with a link', () => {
    expect(hasLink('see https://example.com/x')).toBe(true);
    expect(hasLink('www.example.com')).toBe(true);
    expect(hasLink('no link: example dot com')).toBe(false);
    expect(matches(msg('a', 'dns at http://x.test'), f({ text: 'dns', hasLink: true }))).toBe(true);
    expect(matches(msg('a', 'dns'), f({ text: 'dns', hasLink: true }))).toBe(false);
  });

  it('an empty search finds nothing; a filter alone is a search', () => {
    expect(isActive(EMPTY_FILTERS)).toBe(false);
    expect(isActive(f({ text: '   ' }))).toBe(false);
    expect(isActive(f({ hasLink: true }))).toBe(true);
    expect(search([msg('a', 'x')], EMPTY_FILTERS)).toEqual([]);
  });

  it('results come newest first', () => {
    const lines = [msg('a', 'dns 1', T0), msg('b', 'other', T0 + 1), msg('c', 'DNS 2', T0 + 2)];
    expect(search(lines, f({ text: 'dns' })).map((m) => m.text)).toEqual(['DNS 2', 'dns 1']);
  });
});

describe('mergeLines', () => {
  it('one list, oldest first, without the copies a line has in both places', () => {
    const live = [msg('a', 'two', T0 + 2000, { msgid: 'x2' }), msg('a', 'three', T0 + 3000)];
    const fetched = [msg('a', 'one', T0 + 1000, { msgid: 'x1' }), msg('a', 'two', T0 + 2000, { msgid: 'x2' }), msg('a', 'three', T0 + 3000)];
    expect(mergeLines(live, fetched).map((m) => m.text)).toEqual(['one', 'two', 'three']);
  });
});

describe('authorsOf', () => {
  it('each nick once, from what people said', () => {
    expect(authorsOf([msg('a', 'x'), msg('A', 'y'), msg('b', 'z'), msg('srv', 'j', T0, { kind: 'join' })])).toEqual(['a', 'b']);
  });
});

describe('highlightParts', () => {
  it('marks every occurrence, keeping the original case', () => {
    expect(highlightParts('DNS and dns', 'dns')).toEqual([
      { text: 'DNS', match: true }, { text: ' and ', match: false }, { text: 'dns', match: true },
    ]);
  });

  it('no needle, no match: the text as it is', () => {
    expect(highlightParts('hello', '')).toEqual([{ text: 'hello', match: false }]);
    expect(highlightParts('hello', 'zz')).toEqual([{ text: 'hello', match: false }]);
  });

  it('a match far into a long line: the start is dropped (…) so it shows', () => {
    const text = `${'word '.repeat(40)}the DNS bit`;
    const parts = highlightParts(text, 'dns');
    expect(parts[0]!.text.startsWith('…')).toBe(true);
    expect(parts[0]!.text.length).toBeLessThan(60);
    expect(parts.find((p) => p.match)?.text).toBe('DNS');
    // Not trimmed when asked not to.
    expect(highlightParts(text, 'dns', -1)[0]!.text.startsWith('word')).toBe(true);
  });

  it('is plain text: markup in a message stays text', () => {
    expect(highlightParts('<b>dns</b>', 'dns')).toEqual([
      { text: '<b>', match: false }, { text: 'dns', match: true }, { text: '</b>', match: false },
    ]);
  });
});

describe('days', () => {
  const now = new Date(2026, 10, 24, 10, 0).getTime();
  it('Today, Yesterday, then the date (with the year outside this one)', () => {
    expect(dayLabel(new Date(2026, 10, 24, 0, 5).getTime(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 10, 23, 23, 59).getTime(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 10, 12, 9).getTime(), now)).toBe('Nov 12');
    expect(dayLabel(new Date(2025, 7, 26, 9).getTime(), now)).toBe('Aug 26, 2025');
  });

  it('groups results (newest first) under their day', () => {
    const rs = [
      msg('a', '1', new Date(2026, 10, 24, 9).getTime()),
      msg('a', '2', new Date(2026, 10, 24, 8).getTime()),
      msg('a', '3', new Date(2026, 10, 23, 22).getTime()),
    ];
    expect(groupByDay(rs, now).map((g) => [g.label, g.items.length])).toEqual([['Today', 2], ['Yesterday', 1]]);
  });
});

describe('contextOf', () => {
  it('up to 3 lines either side, skipping joins and parts', () => {
    const lines = [
      msg('a', 'b1'), msg('a', 'b2'), msg('x', '', T0, { kind: 'join' }), msg('a', 'b3'), msg('a', 'b4'),
      msg('k', 'hit'), msg('a', 'a1'), msg('a', 'a2'),
    ];
    const target = lines[5]!;
    const ctx = contextOf(lines, target);
    expect(ctx.before.map((m) => m.text)).toEqual(['b2', 'b3', 'b4']);
    expect(ctx.after.map((m) => m.text)).toEqual(['a1', 'a2']);
  });
});
