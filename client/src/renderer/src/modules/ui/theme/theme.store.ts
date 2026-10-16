import { THEME_TOKENS, type Theme, type ThemeEntry } from './theme.types';
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from './themes.builtin';
import { parseTheme, serializeTheme } from './theme.parse';

// The active theme and the user's own themes.
//
// In the desktop app, custom themes are JSON files in <userData>/themes/,
// read and written through the shell (`bosonThemes`, desktop/themes.go), which
// also watches the folder so a file edited in any editor re-applies live.
// Local storage keeps a copy of each so the active theme paints the very
// first frame (before the async file read) and so the browser build, which
// has no bridge, still has custom themes at all.
//
// Applying a theme sets each token as an inline custom property on <html>,
// over the defaults in tokens.css; derived tokens (--accent-dim, the focus
// ring) are written in terms of these and follow automatically.

const ACTIVE_KEY = 'boson:theme:v1';

// Font stacks per ThemeFont. 'boson' repeats tokens.css so switching back
// from a system-font theme restores it.
const FONTS: Record<Theme['font'], { body: string; display: string }> = {
  boson: {
    body: "'Inter', -apple-system, system-ui, sans-serif",
    display: "'JetBrains Mono', ui-monospace, monospace",
  },
  system: {
    body: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Cantarell, Ubuntu, 'Noto Sans', system-ui, sans-serif",
    display: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI', Cantarell, Ubuntu, 'Noto Sans', system-ui, sans-serif",
  },
};
const CUSTOM_KEY = 'boson:themes:custom:v1';

export interface ThemeFilesBridge {
  list(): Promise<Array<{ id: string; text: string }>>;
  write(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
  openFolder(): Promise<void>;
  onChange(fn: () => void): () => void;
}

export interface ThemeFileError {
  id: string;
  error: string;
}

export interface ThemeState {
  themes: ThemeEntry[];
  activeId: string;
  // Files in the themes folder that couldn't be read as a theme.
  fileErrors: ThemeFileError[];
  // Whether themes live in a folder the user can open (desktop app).
  hasFolder: boolean;
}

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function storage(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch { /* best-effort */ }
}

export function themeBridge(): ThemeFilesBridge | null {
  return (globalThis as { bosonThemes?: ThemeFilesBridge }).bosonThemes ?? null;
}

// File-name-safe id from a theme name: "My Nord!" → "my-nord".
export function themeIdFor(name: string, taken: (id: string) => boolean): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'theme';
  let id = slug;
  for (let n = 2; taken(id); n++) id = `${slug}-${n}`;
  return id;
}

export class ThemeStore {
  private custom = new Map<string, Theme>();
  private fileErrors: ThemeFileError[] = [];
  private activeId: string;
  private preview: Theme | null = null;
  private listeners = new Set<() => void>();
  private stopWatch: (() => void) | null = null;

  constructor(
    private readonly bridge: ThemeFilesBridge | null = themeBridge(),
    private readonly root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
  ) {
    for (const [id, text] of Object.entries(readJson<Record<string, string>>(CUSTOM_KEY) ?? {})) {
      const r = parseTheme(text);
      if (r.ok) this.custom.set(id, r.theme);
    }
    this.activeId = readJson<{ active?: string }>(ACTIVE_KEY)?.active ?? DEFAULT_THEME_ID;
  }

  // Applies the cached theme now, then loads the themes folder and watches it.
  async init(): Promise<void> {
    this.apply();
    if (!this.bridge) return;
    this.stopWatch = this.bridge.onChange(() => { void this.reload(); });
    await this.reload();
  }

  dispose(): void {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  // Re-reads the themes folder; the files are the truth in the desktop app.
  async reload(): Promise<void> {
    if (!this.bridge) return;
    let files: Array<{ id: string; text: string }>;
    try {
      files = await this.bridge.list();
    } catch {
      return;
    }
    const custom = new Map<string, Theme>();
    const errors: ThemeFileError[] = [];
    for (const f of files) {
      const r = parseTheme(f.text, f.id);
      if (r.ok) custom.set(f.id, r.theme);
      else errors.push({ id: f.id, error: r.error });
    }
    this.custom = custom;
    this.fileErrors = errors;
    this.persistCache();
    this.changed();
  }

  getState(): ThemeState {
    const customs: ThemeEntry[] = [...this.custom.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([id, theme]) => ({ id, theme, builtin: false, group: 'custom' as const }));
    return {
      themes: [...BUILTIN_THEMES, ...customs],
      activeId: this.resolveActive().id,
      fileErrors: this.fileErrors,
      hasFolder: this.bridge !== null,
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  setActive(id: string): void {
    this.activeId = id;
    writeJson(ACTIVE_KEY, { active: id });
    this.changed();
  }

  // Shows `theme` without saving anything (the editor's live preview).
  // null goes back to the active theme.
  setPreview(theme: Theme | null): void {
    this.preview = theme;
    this.apply();
  }

  // Saves a custom theme (new when `id` is omitted) and makes it active.
  async save(theme: Theme, id?: string): Promise<string> {
    const isBuiltin = (c: string): boolean => BUILTIN_THEMES.some((b) => b.id === c);
    const target = id && !isBuiltin(id)
      ? id
      : themeIdFor(theme.name, (c) => this.custom.has(c) || isBuiltin(c));
    this.custom.set(target, theme);
    this.persistCache();
    if (this.bridge) await this.bridge.write(target, serializeTheme(theme));
    this.preview = null;
    this.setActive(target);
    return target;
  }

  async remove(id: string): Promise<void> {
    if (!this.custom.has(id) && !this.fileErrors.some((e) => e.id === id)) return;
    this.custom.delete(id);
    this.fileErrors = this.fileErrors.filter((e) => e.id !== id);
    this.persistCache();
    if (this.bridge) await this.bridge.remove(id);
    this.changed();
  }

  async openFolder(): Promise<void> {
    await this.bridge?.openFolder();
  }

  themeFor(id: string): Theme | null {
    return this.custom.get(id) ?? BUILTIN_THEMES.find((b) => b.id === id)?.theme ?? null;
  }

  // The active theme; an id whose theme is gone (file deleted) falls back
  // to the default without forgetting the choice, so it returns if the file does.
  private resolveActive(): ThemeEntry {
    const custom = this.custom.get(this.activeId);
    if (custom) return { id: this.activeId, theme: custom, builtin: false, group: 'custom' };
    return BUILTIN_THEMES.find((b) => b.id === this.activeId) ?? BUILTIN_THEMES[0]!;
  }

  private persistCache(): void {
    const out: Record<string, string> = {};
    for (const [id, theme] of this.custom) out[id] = serializeTheme(theme);
    writeJson(CUSTOM_KEY, out);
  }

  private changed(): void {
    this.apply();
    for (const fn of this.listeners) fn();
  }

  private apply(): void {
    const root = this.root;
    if (!root) return;
    const theme = this.preview ?? this.resolveActive().theme;
    for (const t of THEME_TOKENS) root.style.setProperty(`--${t.key}`, theme.colors[t.key]);
    root.style.setProperty('--nick-s', `${theme.nick.saturation}%`);
    root.style.setProperty('--nick-l', `${theme.nick.lightness}%`);
    root.style.setProperty('--radius-sm', `${theme.radius}px`);
    root.style.setProperty('--radius-md', `${theme.radius * 2}px`);
    root.style.setProperty('--radius-lg', `${theme.radius * 3}px`);
    root.style.setProperty('--font-body', FONTS[theme.font].body);
    root.style.setProperty('--font-display', FONTS[theme.font].display);
    root.style.colorScheme = theme.base;
    root.dataset['themeBase'] = theme.base;
  }
}

let store: ThemeStore | null = null;

export function getThemeStore(): ThemeStore {
  store ??= new ThemeStore();
  return store;
}

// Tests only.
export function setThemeStore(s: ThemeStore | null): void {
  store = s;
}
