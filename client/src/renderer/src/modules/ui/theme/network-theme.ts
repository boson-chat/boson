import { MAX_RADIUS, THEME_TOKENS, type Theme, type ThemeBase, type ThemeColors, type ThemeFont, type ThemeToken } from './theme.types';
import { baseTheme } from './themes.builtin';

// A network's theme: boson-theme/1, the document a self-hosted stack serves
// at <auth>/v1/branding and a directory listing carries as `theme`. The
// same rules hold everywhere (servers validate on write, the client again
// on read):
//
//   - colours are #rrggbb, for any subset of THEME_TOKENS;
//   - nick saturation / lightness 0–100, radius 0–12, font boson | system;
//   - panes.<servers|channels|messages|members>: bg (#rrggbb), image (URL),
//     dim 0–1, blur 0–24 (px), position center | top | bottom | left | right;
//   - logo, logo_wide, login_background: image URLs;
//   - variants.<dark|light>: a version for the other base (colours, nick,
//     panes, by the same rules); one for `base` itself is dropped. radius,
//     font and the images above stay shared.
//   - image URLs are https (http to loopback in dev builds);
//   - unknown keys are dropped; the whole document is at most 16 KB.
//
// A value that breaks a rule is dropped (the user's own value stays), not
// clamped: a network that sends nonsense shouldn't get a near miss.

export const MAX_NETWORK_THEME_BYTES = 16 * 1024;
export const MAX_PANE_BLUR = 24;
// The dim overlay when a pane has an image but doesn't say: enough to keep
// text readable on a busy picture.
export const DEFAULT_PANE_DIM = 0.6;
// WCAG AA for body text.
export const MIN_TEXT_CONTRAST = 4.5;

export const PANE_NAMES = ['servers', 'channels', 'messages', 'members'] as const;
export type PaneName = (typeof PANE_NAMES)[number];
export const PANE_POSITIONS = ['center', 'top', 'bottom', 'left', 'right'] as const;
export type PanePosition = (typeof PANE_POSITIONS)[number];

export interface PaneStyle {
  bg?: string;
  image?: string;
  dim?: number;
  blur?: number;
  position?: PanePosition;
}

export interface NickTuning {
  saturation?: number;
  lightness?: number;
}

// The theme for the base that isn't the document's `base`: its colours and
// nick tuning (in place of the primary's), and pane overrides laid over the
// primary's panes field by field (a pane's image stays the primary's unless
// the variant names one).
export interface NetworkThemeVariant {
  colors: Partial<ThemeColors>;
  nick?: NickTuning;
  panes: Partial<Record<PaneName, PaneStyle>>;
}

export interface NetworkTheme {
  version: 1;
  base: ThemeBase;
  colors: Partial<ThemeColors>;
  nick?: NickTuning;
  // At most the one for the other base.
  variants?: Partial<Record<ThemeBase, NetworkThemeVariant>>;
  radius?: number;
  font?: ThemeFont;
  panes: Partial<Record<PaneName, PaneStyle>>;
  logo?: string;
  logo_wide?: string;
  login_background?: string;
}

// The document's images, by slot: logo, logo_wide, login_background,
// panes.<name>.image and variants.<base>.panes.<name>.image.
export type ImageSlot =
  | 'logo' | 'logo_wide' | 'login_background' | `panes.${PaneName}.image` | `variants.${ThemeBase}.panes.${PaneName}.image`;

export interface NetworkThemeParseOptions {
  // Dev / e2e builds: http:// image URLs on a loopback host.
  allowLoopbackHttp?: boolean;
}

const HEX6 = /^#[0-9a-f]{6}$/i;
const TEXT_TOKENS: readonly ThemeToken[] = THEME_TOKENS.filter((t) => t.group === 'Text').map((t) => t.key);
const SURFACE_TOKENS: readonly ThemeToken[] = THEME_TOKENS.filter((t) => t.group === 'Surfaces').map((t) => t.key);
const TOKEN_KEYS = new Set<string>(THEME_TOKENS.map((t) => t.key));

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

// An image URL the client will load: https (no credentials), or http to
// loopback in dev builds.
export function isBrandingUrl(value: unknown, opts: NetworkThemeParseOptions = {}): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.username || u.password || !u.hostname) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && !!opts.allowLoopbackHttp && isLoopbackHost(u.hostname);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const inRange = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function byteLength(s: string): number {
  return typeof TextEncoder === 'undefined' ? s.length : new TextEncoder().encode(s).length;
}

// Parses and validates a boson-theme/1 document (JSON text or an already
// parsed value, e.g. a directory listing's `theme`). null when it isn't one
// at all: not an object, the wrong version, over 16 KB.
export function parseNetworkTheme(input: unknown, opts: NetworkThemeParseOptions = {}): NetworkTheme | null {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (byteLength(input) > MAX_NETWORK_THEME_BYTES) return null;
    try {
      raw = JSON.parse(input);
    } catch {
      return null;
    }
  } else {
    let text: string | undefined;
    try {
      text = JSON.stringify(input);
    } catch {
      return null;
    }
    if (text === undefined || byteLength(text) > MAX_NETWORK_THEME_BYTES) return null;
  }
  if (!isObj(raw)) return null;
  if (raw['version'] !== undefined && raw['version'] !== 1) return null;

  const out: NetworkTheme = {
    version: 1,
    base: raw['base'] === 'light' ? 'light' : 'dark',
    colors: parseColors(raw['colors']),
    panes: parsePanes(raw['panes'], opts),
  };
  const nick = parseNick(raw['nick']);
  if (nick) out.nick = nick;
  if (inRange(raw['radius'], 0, MAX_RADIUS)) out.radius = Math.round(raw['radius']);
  if (raw['font'] === 'boson' || raw['font'] === 'system') out.font = raw['font'];

  if (isObj(raw['variants'])) {
    const other: ThemeBase = out.base === 'dark' ? 'light' : 'dark';
    const v = raw['variants'][other];
    if (isObj(v)) {
      const variant: NetworkThemeVariant = { colors: parseColors(v['colors']), panes: parsePanes(v['panes'], opts) };
      const vnick = parseNick(v['nick']);
      if (vnick) variant.nick = vnick;
      out.variants = { [other]: variant };
    }
  }

  for (const slot of ['logo', 'logo_wide', 'login_background'] as const) {
    if (isBrandingUrl(raw[slot], opts)) out[slot] = raw[slot];
  }
  return out;
}

function parseColors(raw: unknown): Partial<ThemeColors> {
  const out: Partial<ThemeColors> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (TOKEN_KEYS.has(k) && typeof v === 'string' && HEX6.test(v)) out[k as ThemeToken] = v.toLowerCase();
  }
  return out;
}

function parseNick(raw: unknown): NickTuning | undefined {
  if (!isObj(raw)) return undefined;
  const n: NickTuning = {};
  if (inRange(raw['saturation'], 0, 100)) n.saturation = Math.round(raw['saturation']);
  if (inRange(raw['lightness'], 0, 100)) n.lightness = Math.round(raw['lightness']);
  return n.saturation !== undefined || n.lightness !== undefined ? n : undefined;
}

function parsePanes(raw: unknown, opts: NetworkThemeParseOptions): Partial<Record<PaneName, PaneStyle>> {
  const out: Partial<Record<PaneName, PaneStyle>> = {};
  if (!isObj(raw)) return out;
  for (const name of PANE_NAMES) {
    const p = raw[name];
    if (!isObj(p)) continue;
    const pane: PaneStyle = {};
    if (typeof p['bg'] === 'string' && HEX6.test(p['bg'])) pane.bg = p['bg'].toLowerCase();
    if (isBrandingUrl(p['image'], opts)) pane.image = p['image'];
    if (inRange(p['dim'], 0, 1)) pane.dim = p['dim'];
    if (inRange(p['blur'], 0, MAX_PANE_BLUR)) pane.blur = p['blur'];
    if (typeof p['position'] === 'string' && (PANE_POSITIONS as readonly string[]).includes(p['position'])) {
      pane.position = p['position'] as PanePosition;
    }
    if (Object.keys(pane).length > 0) out[name] = pane;
  }
  return out;
}

// Every image URL the document names, by slot.
export function themeImages(theme: NetworkTheme): Partial<Record<ImageSlot, string>> {
  const out: Partial<Record<ImageSlot, string>> = {};
  if (theme.logo) out.logo = theme.logo;
  if (theme.logo_wide) out.logo_wide = theme.logo_wide;
  if (theme.login_background) out.login_background = theme.login_background;
  for (const name of PANE_NAMES) {
    const img = theme.panes[name]?.image;
    if (img) out[`panes.${name}.image`] = img;
  }
  for (const [vbase, v] of Object.entries(theme.variants ?? {}) as Array<[ThemeBase, NetworkThemeVariant]>) {
    for (const name of PANE_NAMES) {
      const img = v.panes[name]?.image;
      if (img) out[`variants.${vbase}.panes.${name}.image`] = img;
    }
  }
  return out;
}

// What a network's theme looks like for a user on `userBase`: its variant
// for that base when it has one (base = userBase, the variant's colours and
// nick, the primary's panes overlaid by the variant's), else the primary.
// `imageSlots` says which image slot each pane's picture comes from.
export interface ChosenVariant {
  base: ThemeBase;
  // The variant for userBase was picked (not the primary).
  variant: boolean;
  colors: Partial<ThemeColors>;
  nick?: NickTuning;
  panes: Partial<Record<PaneName, PaneStyle>>;
  imageSlots: Partial<Record<PaneName, ImageSlot>>;
}

export function chooseVariant(net: NetworkTheme, userBase: ThemeBase): ChosenVariant {
  const v = userBase !== net.base ? net.variants?.[userBase] : undefined;
  const imageSlots: Partial<Record<PaneName, ImageSlot>> = {};
  if (!v) {
    for (const name of PANE_NAMES) if (net.panes[name]?.image) imageSlots[name] = `panes.${name}.image`;
    return { base: net.base, variant: false, colors: net.colors, ...(net.nick ? { nick: net.nick } : {}), panes: net.panes, imageSlots };
  }
  const panes: Partial<Record<PaneName, PaneStyle>> = {};
  for (const name of PANE_NAMES) {
    const p = net.panes[name];
    const o = v.panes[name];
    if (!p && !o) continue;
    panes[name] = { ...p, ...o };
    if (o?.image) imageSlots[name] = `variants.${userBase}.panes.${name}.image`;
    else if (p?.image) imageSlots[name] = `panes.${name}.image`;
  }
  return { base: userBase, variant: true, colors: v.colors, ...(v.nick ? { nick: v.nick } : {}), panes, imageSlots };
}

// Whether the document changes anything in the app itself (colours, shape,
// panes) — as opposed to only branding the sign-in screen.
export function themeHasLook(theme: NetworkTheme): boolean {
  return Object.keys(theme.colors).length > 0 || theme.nick !== undefined || theme.radius !== undefined ||
    theme.font !== undefined || Object.keys(theme.panes).length > 0 ||
    Object.values(theme.variants ?? {}).some((v) => Object.keys(v.colors).length > 0 || v.nick !== undefined || Object.keys(v.panes).length > 0);
}

// ---- contrast ----

function hexRgb(value: string): [number, number, number] | null {
  const v = value.trim();
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})([0-9a-f])?$/i.exec(v);
  if (m) {
    const [r, g, b] = m[1]!.split('').map((c) => parseInt(c + c, 16));
    return [r!, g!, b!];
  }
  return null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// WCAG contrast ratio of two colours (1–21), or null when either isn't a
// hex colour (a custom theme's oklch(), say): not judged.
export function contrastRatio(a: string, b: string): number | null {
  const x = hexRgb(a);
  const y = hexRgb(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const readable = (fg: string, bg: string): boolean => (contrastRatio(fg, bg) ?? MIN_TEXT_CONTRAST) >= MIN_TEXT_CONTRAST;

function textReadable(c: ThemeColors): boolean {
  return readable(c.fg, c.bg) && readable(c.fg, c.surface);
}

// ---- merge ----

export interface MergeResult {
  theme: Theme;
  // The readability guard dropped the network's text colours (and, when
  // that wasn't enough, its surfaces too).
  droppedText: boolean;
  droppedSurfaces: boolean;
  // Pane backgrounds dropped because text on them would be unreadable.
  droppedPanes: PaneName[];
  panes: Partial<Record<PaneName, PaneStyle>>;
  // Which image slot each pane's picture comes from (for paneVars).
  imageSlots: Partial<Record<PaneName, ImageSlot>>;
  // The network's variant for the user's base was used (not its primary).
  variant: boolean;
}

// The user's theme with a network's merged over it. A network on the same
// base keeps the user's other colours; one on the other base fills in from
// Boson's built-in of its base (a light network over a dark theme would
// otherwise mix the two).
//
// Readability guard: when the merged text-on-background contrast is under
// 4.5:1, the network's text colours are dropped for the user's (or the
// base's); if it's still unreadable, its surfaces go too. A pane
// background text would be unreadable on is dropped.
//
// A network with a variant for the user's base uses that (chooseVariant),
// so a light user gets its light version; the guard judges the variant.
export function mergeNetworkTheme(user: Theme, doc: NetworkTheme): MergeResult {
  const net = chooseVariant(doc, user.base);
  const start = net.base === user.base ? user : baseTheme(net.base);
  const colors: ThemeColors = { ...start.colors, ...net.colors };
  let droppedText = false;
  let droppedSurfaces = false;
  if (!textReadable(colors)) {
    for (const k of TEXT_TOKENS) if (net.colors[k] !== undefined) { colors[k] = start.colors[k]; droppedText = true; }
    if (!textReadable(colors)) {
      for (const k of SURFACE_TOKENS) if (net.colors[k] !== undefined) { colors[k] = start.colors[k]; droppedSurfaces = true; }
    }
  }
  const panes: Partial<Record<PaneName, PaneStyle>> = {};
  const droppedPanes: PaneName[] = [];
  for (const name of PANE_NAMES) {
    const p = net.panes[name];
    if (!p) continue;
    if (p.bg && !readable(colors.fg, p.bg)) {
      const { bg: _bg, ...rest } = p;
      droppedPanes.push(name);
      if (Object.keys(rest).length > 0) panes[name] = rest;
    } else {
      panes[name] = p;
    }
  }
  const theme: Theme = {
    name: start.name,
    base: net.base,
    colors,
    nick: {
      saturation: net.nick?.saturation ?? start.nick.saturation,
      lightness: net.nick?.lightness ?? start.nick.lightness,
    },
    radius: doc.radius ?? start.radius,
    font: doc.font ?? start.font,
  };
  return { theme, droppedText, droppedSurfaces, droppedPanes, panes, imageSlots: net.imageSlots, variant: net.variant };
}

// ---- pane CSS variables ----

// The pane custom properties set on <html>: --pane-<name>-bg / -image /
// -dim / -blur / -position. `images` maps an image slot to the URL to use
// (a blob: URL from the shell); a pane image that hasn't loaded yet is left
// out, so the pane just shows its colour until it has. `slots` says which
// slot a pane's image is under (default panes.<name>.image; a variant's own
// picture is under variants.<base>.panes.<name>.image).
export function paneVars(
  panes: Partial<Record<PaneName, PaneStyle>>,
  images: Partial<Record<ImageSlot, string>>,
  slots: Partial<Record<PaneName, ImageSlot>> = {},
): { vars: Record<string, string>; withImage: PaneName[] } {
  const vars: Record<string, string> = {};
  const withImage: PaneName[] = [];
  for (const name of PANE_NAMES) {
    const p = panes[name];
    if (!p) continue;
    if (p.bg) vars[`--pane-${name}-bg`] = p.bg;
    const src = p.image ? images[slots[name] ?? `panes.${name}.image`] : undefined;
    if (src) {
      withImage.push(name);
      vars[`--pane-${name}-image`] = `url("${cssUrl(src)}")`;
      vars[`--pane-${name}-dim`] = String(p.dim ?? DEFAULT_PANE_DIM);
      vars[`--pane-${name}-blur`] = `${p.blur ?? 0}px`;
      vars[`--pane-${name}-position`] = p.position ?? 'center';
    }
  }
  return { vars, withImage };
}

// Every pane property paneVars can set (to clear them).
export const PANE_VAR_NAMES: readonly string[] = PANE_NAMES.flatMap((n) =>
  ['bg', 'image', 'dim', 'blur', 'position'].map((p) => `--pane-${n}-${p}`));

// A URL for inside url("…"): no quote, backslash or newline can end it.
export function cssUrl(u: string): string {
  return u.replace(/["\\\n\r]/g, (c) => encodeURIComponent(c));
}
