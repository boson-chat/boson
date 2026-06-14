import { describe, it, expect } from 'vitest';
import { parseZncNetworks } from './znc.parse';

describe('parseZncNetworks', () => {
  it('extracts network names from a ZNC ListNetworks table', () => {
    const lines = [
      '+---------+-------+-----------------------+----------+',
      '| Network | OnIRC | IRC Server            | Channels |',
      '+---------+-------+-----------------------+----------+',
      '| libera  | Yes   | irc.libera.chat:+6697 | 12       |',
      '| oftc    | No    | (Not connected)       | 0        |',
      '| rizon   | Yes   | irc.rizon.net:+6697   | 3        |',
      '+---------+-------+-----------------------+----------+',
    ];
    expect(parseZncNetworks(lines)).toEqual(['libera', 'oftc', 'rizon']);
  });

  it('skips the header + separator rows', () => {
    expect(parseZncNetworks([
      '| Network | OnIRC |',
      '|=========|=======|',
      '| libera  | Yes   |',
    ])).toEqual(['libera']);
  });

  it('ignores non-table noise lines', () => {
    expect(parseZncNetworks([
      'You have 2 networks:',
      'something without a pipe',
      '',
    ])).toEqual([]);
  });

  it('de-dupes case-insensitively, preserving first-seen order', () => {
    expect(parseZncNetworks([
      '| libera | Yes |',
      '| Libera | No  |',
      '| oftc   | Yes |',
    ])).toEqual(['libera', 'oftc']);
  });
});
