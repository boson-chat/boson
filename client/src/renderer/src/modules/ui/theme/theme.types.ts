// A theme recolours the design-system tokens (packages/shared/.../tokens.css):
// every colour in the app is derived from these, so a theme is a value for
// each. It can also round the corners and swap Boson's fonts for the OS's
// own. Spacing, sizes and motion are not themeable.
//
// On disk (and in Copy JSON) a theme looks like:
//
//   {
//     "name": "My theme",
//     "base": "dark",
//     "colors": { "bg": "#070709", "accent": "#D97706", ... },
//     "nick": { "saturation": 62, "lightness": 64 },
//     "radius": 2,
//     "font": "boson"
//   }
//
// Every field is optional: a missing one comes from the built-in theme of the
// same base (Terminal for dark, Daylight for light).

// The themeable tokens, in the order the editor shows them. `key` is the CSS
// custom property without its leading `--`, and also the JSON key.
export const THEME_TOKENS = [
  { key: 'bg', label: 'Background', group: 'Surfaces' },
  { key: 'surface', label: 'Panels', group: 'Surfaces' },
  { key: 'surface-raised', label: 'Raised panels', group: 'Surfaces' },
  { key: 'surface-hover', label: 'Hover', group: 'Surfaces' },
  { key: 'border', label: 'Borders', group: 'Surfaces' },
  { key: 'border-soft', label: 'Soft borders', group: 'Surfaces' },
  { key: 'fg', label: 'Text', group: 'Text' },
  { key: 'fg-2', label: 'Secondary text', group: 'Text' },
  { key: 'fg-3', label: 'Tertiary text', group: 'Text' },
  { key: 'muted', label: 'Muted', group: 'Text' },
  { key: 'meta', label: 'Faint', group: 'Text' },
  { key: 'accent', label: 'Accent', group: 'Accent' },
  { key: 'accent-on', label: 'Text on accent', group: 'Accent' },
  { key: 'success', label: 'Success', group: 'Status' },
  { key: 'warn', label: 'Warning', group: 'Status' },
  { key: 'danger', label: 'Danger', group: 'Status' },
  { key: 'info', label: 'Info', group: 'Status' },
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number]['key'];
export type ThemeColors = Record<ThemeToken, string>;
export type ThemeBase = 'dark' | 'light';
// 'boson': Inter body + JetBrains Mono headings. 'system': the OS UI font
// for both (San Francisco, Segoe UI, Cantarell…). Code stays monospace.
export type ThemeFont = 'boson' | 'system';

export const MAX_RADIUS = 12;

export interface Theme {
  name: string;
  base: ThemeBase;
  colors: ThemeColors;
  // Saturation / lightness (percent) for the per-nick avatar colours, whose
  // hue comes from the nick. Light backgrounds need darker nicks.
  nick: { saturation: number; lightness: number };
  // Corner radius in px for small controls; medium and large are 2× and 3×.
  // 0 is square, Boson's own look is 2.
  radius: number;
  font: ThemeFont;
}

// A theme the app knows about: a built-in, or one of the user's (a JSON file
// in the themes folder, or local storage outside the desktop app).
export interface ThemeEntry {
  id: string;
  theme: Theme;
  builtin: boolean;
  // Picker heading: Boson's own themes or the user's.
  group: 'boson' | 'custom';
}
