import { describe, it, expect } from 'vitest';
import { parseTable } from './table';

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
