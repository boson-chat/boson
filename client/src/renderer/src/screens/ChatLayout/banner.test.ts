import { describe, it, expect } from 'vitest';
import { parseBanners, splitBannerLine } from './banner';

describe('parseBanners', () => {
  it('reads the text out of framed banners, several per block', () => {
    const text = [
      ' ______________',
      '|   New TV Release: A.Show.S01E01 |',
      ' ¯¯¯¯¯¯¯¯¯¯¯¯¯¯',
      ' ______________',
      '|   New MOVIE Release: A.Film.2026 |',
      ' ¯¯¯¯¯¯¯¯¯¯¯¯¯¯',
    ].join('\n');
    expect(parseBanners(text)).toEqual([
      { lines: ['New TV Release: A.Show.S01E01'] },
      { lines: ['New MOVIE Release: A.Film.2026'] },
    ]);
  });

  it('keeps a multi-line frame together', () => {
    expect(parseBanners('====\n| one |\n| two |\n====')).toEqual([{ lines: ['one', 'two'] }]);
  });

  it('splits frames on blank lines and works without rules', () => {
    expect(parseBanners('| a |\n\n| b |')).toEqual([{ lines: ['a'] }, { lines: ['b'] }]);
  });

  it('is null for anything that is not just frames and rules', () => {
    expect(parseBanners('____\n|  hi |\nsome text\n¯¯¯¯')).toBeNull();
    expect(parseBanners('____\n¯¯¯¯')).toBeNull();
    expect(parseBanners('  /\\_/\\\n ( o.o )')).toBeNull();
  });
});

describe('splitBannerLine', () => {
  it('splits a short label from its value', () => {
    expect(splitBannerLine('New TV Release: South.Park.S29E01.720p')).toEqual({ label: 'New TV Release', value: 'South.Park.S29E01.720p' });
  });
  it('leaves lines without a short label alone', () => {
    expect(splitBannerLine('just a line')).toBeNull();
    expect(splitBannerLine('Time is 10:30')).toBeNull();
    expect(splitBannerLine(`${'x'.repeat(50)}: y`)).toBeNull();
  });
});
