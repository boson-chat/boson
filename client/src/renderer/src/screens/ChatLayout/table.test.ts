import { describe, it, expect } from 'vitest';
import { parseTable, parseTables } from './table';

describe('parseTable', () => {
  it('parses a box-drawing table (┌─┬─┐ │ ├─┼─┤ └─┴─┘)', () => {
    const text = [
      '┌─────────────────┬──────────────────┐',
      '│ Location        │ What it is        │',
      '├─────────────────┼──────────────────┤',
      '│ /home/uptime    │ Uptime Kuma       │',
      '│ /home/mcbot     │ a Minecraft bot   │',
      '└─────────────────┴──────────────────┘',
    ].join('\n');
    const t = parseTable(text);
    expect(t).not.toBeNull();
    expect(t!.headers).toEqual(['Location', 'What it is']);
    expect(t!.rows).toEqual([
      ['/home/uptime', 'Uptime Kuma'],
      ['/home/mcbot', 'a Minecraft bot'],
    ]);
  });

  it('parses a markdown pipe table and drops the --- divider', () => {
    const text = [
      '| Name | Role |',
      '|------|------|',
      '| Ada  | Dev  |',
      '| Bob  | Ops  |',
    ].join('\n');
    const t = parseTable(text)!;
    expect(t.headers).toEqual(['Name', 'Role']);
    expect(t.rows).toEqual([['Ada', 'Dev'], ['Bob', 'Ops']]);
  });

  it('parses an ascii +---+ table', () => {
    const text = [
      '+------+------+',
      '| a    | b    |',
      '+------+------+',
      '| 1    | 2    |',
      '+------+------+',
    ].join('\n');
    const t = parseTable(text)!;
    expect(t.headers).toEqual(['a', 'b']);
    expect(t.rows).toEqual([['1', '2']]);
  });

  it('pads ragged rows to the widest column count', () => {
    const text = '| a | b | c |\n| 1 | 2 |';
    const t = parseTable(text)!;
    expect(t.headers).toEqual(['a', 'b', 'c']);
    expect(t.rows).toEqual([['1', '2', '']]);
  });

  it('returns null for non-table monospace content (ascii art / logs)', () => {
    expect(parseTable('  /\\_/\\\n ( o.o )\n  > ^ <')).toBeNull();
    expect(parseTable('just one line with | a pipe')).toBeNull(); // single row
  });
});

describe('parseTables (multiple tables in one block)', () => {
  it('splits two box tables pasted back-to-back', () => {
    const text = [
      '┌────┬────┐',
      '│ a  │ b  │',
      '├────┼────┤',
      '│ 1  │ 2  │',
      '└────┴────┘',
      '┌────┬────┐',
      '│ c  │ d  │',
      '├────┼────┤',
      '│ 3  │ 4  │',
      '└────┴────┘',
    ].join('\n');
    const ts = parseTables(text)!;
    expect(ts).toHaveLength(2);
    expect(ts[0]!.headers).toEqual(['a', 'b']);
    expect(ts[0]!.rows).toEqual([['1', '2']]);
    expect(ts[1]!.headers).toEqual(['c', 'd']);
    expect(ts[1]!.rows).toEqual([['3', '4']]);
  });

  it('splits two markdown tables and a blank-separated pair', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n| c | d |\n|---|---|\n| 3 | 4 |';
    expect(parseTables(md)!).toHaveLength(2);

    const blankSep = '| a | b |\n|---|---|\n| 1 | 2 |\n\n| c | d |\n|---|---|\n| 3 | 4 |';
    const ts = parseTables(blankSep)!;
    expect(ts).toHaveLength(2);
    expect(ts[1]!.headers).toEqual(['c', 'd']);
  });

  it('returns null when any line is not part of a table', () => {
    expect(parseTables('| a | b |\n|---|---|\n| 1 | 2 |\nplain text line')).toBeNull();
  });

  it('tolerates empty/spacer rows (does not bail to a single merged block)', () => {
    const text = [
      '┌─────────────┬──────────────┐',
      '│             │              │', // spacer row → skipped, not fatal
      '│ Location    │ What it is   │',
      '├─────────────┼──────────────┤',
      '│ /home/kuma  │ Uptime Kuma  │',
      '└─────────────┴──────────────┘',
      '┌─────────────┬──────────────┐',
      '│ Role        │ Count        │',
      '├─────────────┼──────────────┤',
      '│ op          │ 3            │',
      '└─────────────┴──────────────┘',
    ].join('\n');
    const ts = parseTables(text)!;
    expect(ts).toHaveLength(2);
    expect(ts[0]!.headers).toEqual(['Location', 'What it is']);
    expect(ts[0]!.rows).toEqual([['/home/kuma', 'Uptime Kuma']]);
    expect(ts[1]!.headers).toEqual(['Role', 'Count']);
  });
});
