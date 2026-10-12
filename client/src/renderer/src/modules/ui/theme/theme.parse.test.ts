import { describe, it, expect } from 'vitest';
import { isThemeColor, parseTheme, serializeTheme } from './theme.parse';
import { BUILTIN_THEMES, baseTheme } from './themes.builtin';
import { THEME_TOKENS } from './theme.types';

describe('parseTheme', () => {
  it('fills missing colours from the base theme', () => {
    const r = parseTheme(JSON.stringify({ name: 'Mine', base: 'light', colors: { accent: '#ff0066' } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.theme.colors.accent).toBe('#ff0066');
    expect(r.theme.colors.bg).toBe(baseTheme('light').colors.bg);
    expect(r.theme.nick).toEqual(baseTheme('light').nick);
    expect(r.warnings).toEqual([]);
  });

  it('defaults name and base, and warns about what it ignored', () => {
    const r = parseTheme({ base: 'sepia', colors: { bogus: '#fff', fg: 'url(https://evil/x)', bg: 'red; color: blue' } }, 'file-name');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.theme.name).toBe('file-name');
    expect(r.theme.base).toBe('dark');
    expect(r.theme.colors.fg).toBe(baseTheme('dark').colors.fg);
    expect(r.theme.colors.bg).toBe(baseTheme('dark').colors.bg);
    expect(r.warnings).toHaveLength(4);
  });

  it('rejects what is not a theme object', () => {
    expect(parseTheme('{nope').ok).toBe(false);
    expect(parseTheme('[]').ok).toBe(false);
    expect(parseTheme('"too large"').ok).toBe(false);
    expect(parseTheme({ colors: 'red' }).ok).toBe(false);
    expect(parseTheme('x'.repeat(70 * 1024)).ok).toBe(false);
  });

  it('reads corner radius and font, falling back with a warning', () => {
    const r = parseTheme({ radius: 6, font: 'system' });
    expect(r.ok && [r.theme.radius, r.theme.font]).toEqual([6, 'system']);
    const bad = parseTheme({ radius: 40, font: 'comic-sans' });
    expect(bad.ok && [bad.theme.radius, bad.theme.font]).toEqual([12, 'boson']);
    expect(bad.ok && bad.warnings).toHaveLength(2);
    const none = parseTheme({ base: 'light' });
    expect(none.ok && [none.theme.radius, none.theme.font]).toEqual([2, 'boson']);
  });

  it('clamps nick percentages', () => {
    const r = parseTheme({ nick: { saturation: 140, lightness: -3 } });
    expect(r.ok && r.theme.nick).toEqual({ saturation: 100, lightness: 0 });
  });

  it('round-trips every built-in through its file form', () => {
    for (const b of BUILTIN_THEMES) {
      const r = parseTheme(serializeTheme(b.theme));
      expect(r.ok && r.theme).toEqual(b.theme);
    }
  });

  it('built-ins define every token', () => {
    for (const b of BUILTIN_THEMES) {
      for (const t of THEME_TOKENS) expect(isThemeColor(b.theme.colors[t.key]), `${b.id}.${t.key}`).toBe(true);
    }
  });
});

describe('isThemeColor', () => {
  it.each(['#abc', '#AABBCC', '#aabbcc80', 'rgb(1 2 3)', 'hsl(10 20% 30%)', 'oklch(0.7 0.1 200)', 'teal'])('accepts %s', (v) => {
    expect(isThemeColor(v)).toBe(true);
  });
  it.each(['', 'url(x)', 'var(--bg)', 'red;', '#12', 'a{b}', 'x'.repeat(80)])('rejects %s', (v) => {
    expect(isThemeColor(v)).toBe(false);
  });
});
