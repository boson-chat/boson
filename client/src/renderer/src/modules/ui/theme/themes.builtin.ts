import type { Theme, ThemeEntry } from './theme.types';

// Terminal is the stock look, exactly the values in tokens.css. Keep them in
// step: tokens.css paints the first frame, before any theme is applied.
const terminal: Theme = {
  name: 'Terminal',
  base: 'dark',
  colors: {
    bg: '#070709',
    surface: '#0D0D11',
    'surface-raised': '#141418',
    'surface-hover': '#1A1A20',
    border: '#24242E',
    'border-soft': '#1C1C24',
    fg: '#E2E2EA',
    'fg-2': '#9898A8',
    'fg-3': '#686878',
    muted: '#444452',
    meta: '#363644',
    accent: '#D97706',
    'accent-on': '#070709',
    success: '#10B981',
    warn: '#F59E0B',
    danger: '#EF4444',
    info: '#3B82F6',
  },
  nick: { saturation: 62, lightness: 64 },
};

const daylight: Theme = {
  name: 'Daylight',
  base: 'light',
  colors: {
    bg: '#F4F4F0',
    surface: '#FBFBF9',
    'surface-raised': '#FFFFFF',
    'surface-hover': '#ECECE6',
    border: '#D6D6CE',
    'border-soft': '#E4E4DD',
    fg: '#1B1B21',
    'fg-2': '#4E4E5A',
    'fg-3': '#6E6E7A',
    muted: '#9C9CA6',
    meta: '#C2C2C8',
    accent: '#B45309',
    'accent-on': '#FFFFFF',
    success: '#047857',
    warn: '#B45309',
    danger: '#DC2626',
    info: '#2563EB',
  },
  nick: { saturation: 60, lightness: 38 },
};

// Nord (nordtheme.com), polar night surfaces + frost accent.
const nord: Theme = {
  name: 'Nord',
  base: 'dark',
  colors: {
    bg: '#242933',
    surface: '#2E3440',
    'surface-raised': '#3B4252',
    'surface-hover': '#434C5E',
    border: '#4C566A',
    'border-soft': '#3B4252',
    fg: '#ECEFF4',
    'fg-2': '#D8DEE9',
    'fg-3': '#A0A9BA',
    muted: '#6E788C',
    meta: '#4C566A',
    accent: '#88C0D0',
    'accent-on': '#2E3440',
    success: '#A3BE8C',
    warn: '#EBCB8B',
    danger: '#BF616A',
    info: '#81A1C1',
  },
  nick: { saturation: 45, lightness: 70 },
};

// Solarized (ethanschoonover.com/solarized), dark variant.
const solarized: Theme = {
  name: 'Solarized',
  base: 'dark',
  colors: {
    bg: '#00212B',
    surface: '#002B36',
    'surface-raised': '#073642',
    'surface-hover': '#0B414F',
    border: '#174C5A',
    'border-soft': '#0D3C48',
    fg: '#EEE8D5',
    'fg-2': '#93A1A1',
    'fg-3': '#839496',
    muted: '#586E75',
    meta: '#2E5662',
    accent: '#B58900',
    'accent-on': '#002B36',
    success: '#859900',
    warn: '#CB4B16',
    danger: '#DC322F',
    info: '#268BD2',
  },
  nick: { saturation: 55, lightness: 62 },
};

// Green-phosphor CRT.
const phosphor: Theme = {
  name: 'Phosphor',
  base: 'dark',
  colors: {
    bg: '#040704',
    surface: '#080D08',
    'surface-raised': '#0D150D',
    'surface-hover': '#122012',
    border: '#1C2E1C',
    'border-soft': '#142214',
    fg: '#B6F2B6',
    'fg-2': '#7DBF7D',
    'fg-3': '#5A8C5A',
    muted: '#3A5C3A',
    meta: '#2A422A',
    accent: '#39FF6A',
    'accent-on': '#040704',
    success: '#39FF6A',
    warn: '#E2E24A',
    danger: '#FF5C5C',
    info: '#5CCCFF',
  },
  nick: { saturation: 70, lightness: 66 },
};

export const DEFAULT_THEME_ID = 'terminal';

export const BUILTIN_THEMES: readonly ThemeEntry[] = [
  { id: 'terminal', theme: terminal, builtin: true },
  { id: 'daylight', theme: daylight, builtin: true },
  { id: 'nord', theme: nord, builtin: true },
  { id: 'solarized', theme: solarized, builtin: true },
  { id: 'phosphor', theme: phosphor, builtin: true },
];

// The theme a partial custom theme is filled in from.
export function baseTheme(base: Theme['base']): Theme {
  return base === 'light' ? daylight : terminal;
}
