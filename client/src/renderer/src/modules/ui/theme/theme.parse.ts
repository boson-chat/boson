import { THEME_TOKENS, type Theme, type ThemeBase, type ThemeColors } from './theme.types';
import { baseTheme } from './themes.builtin';

// Theme JSON comes from files the user (or anyone who handed them a theme)
// wrote, so it is parsed defensively: only the known colour tokens are read,
// each must be a plain CSS colour (no url(), no var(), nothing that could
// carry more than a colour), and anything else is reported and ignored.

export const MAX_THEME_BYTES = 64 * 1024;
const MAX_NAME = 60;
const MAX_COLOR = 64;
// Characters a CSS colour can need: hex, rgb()/hsl()/oklch()/color-mix()
// syntax, named colours. Deliberately excludes ; { } " ' \ : and url(.
const COLOR_CHARS = /^[#a-zA-Z0-9(),.%\s/+-]+$/;

export type ParseResult =
  | { ok: true; theme: Theme; warnings: string[] }
  | { ok: false; error: string };

export function isThemeColor(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > MAX_COLOR || !COLOR_CHARS.test(v) || /url\s*\(|var\s*\(/i.test(v)) return false;
  if (v.startsWith('#')) return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);
  const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
  if (css?.supports) return css.supports('color', v);
  // No CSS.supports (tests): accept the common notations.
  return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ||
    /^(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\(.+\)$/i.test(v) ||
    /^[a-z]+$/i.test(v);
}

const clampPct = (n: unknown, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;

export function parseTheme(input: string | unknown, fallbackName = 'Custom theme'): ParseResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (input.length > MAX_THEME_BYTES) return { ok: false, error: 'Theme file is too large (max 64 KB).' };
    try {
      raw = JSON.parse(input);
    } catch (err) {
      return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'A theme must be a JSON object with "name", "base" and "colors".' };
  }
  const obj = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const base: ThemeBase = obj['base'] === 'light' ? 'light' : 'dark';
  if (obj['base'] !== undefined && obj['base'] !== 'light' && obj['base'] !== 'dark') {
    warnings.push('"base" must be "dark" or "light"; using "dark".');
  }
  const fill = baseTheme(base);

  let name = typeof obj['name'] === 'string' ? obj['name'].trim().slice(0, MAX_NAME) : '';
  if (!name) name = fallbackName;

  const colors: ThemeColors = { ...fill.colors };
  const given = obj['colors'];
  if (given !== undefined && (typeof given !== 'object' || given === null || Array.isArray(given))) {
    return { ok: false, error: '"colors" must be an object of token → colour.' };
  }
  const known = new Set<string>(THEME_TOKENS.map((t) => t.key));
  for (const [key, value] of Object.entries((given ?? {}) as Record<string, unknown>)) {
    if (!known.has(key)) {
      warnings.push(`Unknown colour "${key}" ignored.`);
      continue;
    }
    if (typeof value !== 'string' || !isThemeColor(value)) {
      warnings.push(`"${key}" is not a colour; using the ${fill.name} value.`);
      continue;
    }
    colors[key as keyof ThemeColors] = value.trim();
  }

  const nickRaw = (obj['nick'] && typeof obj['nick'] === 'object' ? obj['nick'] : {}) as Record<string, unknown>;
  const nick = {
    saturation: clampPct(nickRaw['saturation'], fill.nick.saturation),
    lightness: clampPct(nickRaw['lightness'], fill.nick.lightness),
  };

  return { ok: true, theme: { name, base, colors, nick }, warnings };
}

// The file form of a theme: stable key order, two-space indent.
export function serializeTheme(theme: Theme): string {
  const colors: Record<string, string> = {};
  for (const t of THEME_TOKENS) colors[t.key] = theme.colors[t.key];
  return `${JSON.stringify({ name: theme.name, base: theme.base, colors, nick: theme.nick }, null, 2)}\n`;
}
