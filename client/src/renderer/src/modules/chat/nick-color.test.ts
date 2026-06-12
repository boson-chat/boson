import { describe, it, expect } from 'vitest';
import { nickColor, nickInitial } from './nick-color';

describe('nickColor', () => {
  it('is deterministic — same nick always maps to the same color', () => {
    expect(nickColor('alice')).toBe(nickColor('alice'));
  });

  it('is case-insensitive (a nick is the same person regardless of casing)', () => {
    expect(nickColor('Alice')).toBe(nickColor('alice'));
    expect(nickColor('NYAN2')).toBe(nickColor('nyan2'));
  });

  it('returns a valid hsl() string', () => {
    expect(nickColor('bob')).toMatch(/^hsl\(\d{1,3} 62% 64%\)$/);
  });

  it('distinguishes different nicks (no global collapse to one hue)', () => {
    const colors = new Set(['alice', 'bob', 'carol', 'dave', 'erin', 'frank'].map(nickColor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('nickInitial', () => {
  it('uppercases the first alphanumeric character', () => {
    expect(nickInitial('alice')).toBe('A');
    expect(nickInitial('bob123')).toBe('B');
  });

  it('skips a leading IRC status sigil', () => {
    expect(nickInitial('@alice')).toBe('A');
    expect(nickInitial('+bob')).toBe('B');
    expect(nickInitial('~founder')).toBe('F');
  });

  it('handles leading punctuation / digits gracefully', () => {
    expect(nickInitial('[afk]dave')).toBe('A');
    expect(nickInitial('9lives')).toBe('9');
    expect(nickInitial('')).toBe('?');
  });
});
