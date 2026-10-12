import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

// The user's theme files: <userData>/themes/<id>.json. Main only moves text
// in and out of the folder; the renderer parses and validates (theme.parse.ts),
// so main never needs to understand the format. Ids are restricted to a
// file-name-safe alphabet, which also keeps every path inside the folder.

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_BYTES = 64 * 1024;
const MAX_FILES = 200;

const README = `Boson themes
============

Every .json file in this folder is a theme. Edit one in any editor and Boson
re-applies it as soon as you save. Make a new one from Settings > Appearance
(Customize) or by copying an existing file.

{
  "name": "My theme",
  "base": "dark",
  "colors": {
    "bg": "#070709",
    "surface": "#0D0D11",
    "surface-raised": "#141418",
    "surface-hover": "#1A1A20",
    "border": "#24242E",
    "border-soft": "#1C1C24",
    "fg": "#E2E2EA",
    "fg-2": "#9898A8",
    "fg-3": "#686878",
    "muted": "#444452",
    "meta": "#363644",
    "accent": "#D97706",
    "accent-on": "#070709",
    "success": "#10B981",
    "warn": "#F59E0B",
    "danger": "#EF4444",
    "info": "#3B82F6"
  },
  "nick": { "saturation": 62, "lightness": 64 },
  "radius": 2,
  "font": "boson"
}

"base" is "dark" or "light". Anything you leave out comes from the built-in
theme of that base. Colours are CSS colours: #hex, rgb(), hsl(), oklch(), or
names. "nick" sets the saturation and lightness (0-100) of nick avatars.
"radius" is the corner rounding in px (0-12; Boson's own is 2, the macOS look
uses 5). "font" is "boson" (Inter + JetBrains Mono) or "system" (your OS's
UI font).
`;

export function isThemeId(id: unknown): id is string {
  return typeof id === 'string' && ID.test(id);
}

export class ThemeFiles {
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;

  constructor(readonly dir: string) {}

  async ensureDir(): Promise<void> {
    if (existsSync(this.dir)) return;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, 'README.txt'), README, 'utf8');
  }

  async list(): Promise<Array<{ id: string; text: string }>> {
    await this.ensureDir();
    const names = (await readdir(this.dir)).filter((n) => n.toLowerCase().endsWith('.json')).slice(0, MAX_FILES);
    const out: Array<{ id: string; text: string }> = [];
    for (const name of names) {
      const id = name.slice(0, -'.json'.length);
      if (!isThemeId(id)) continue;
      const path = join(this.dir, name);
      try {
        const st = await stat(path);
        if (!st.isFile()) continue;
        // Too big to be a theme: hand the renderer something it reports as an error.
        out.push({ id, text: st.size > MAX_BYTES ? '"too large"' : await readFile(path, 'utf8') });
      } catch {
        // Deleted between readdir and read; the watcher will refresh.
      }
    }
    return out;
  }

  async write(id: unknown, text: unknown): Promise<void> {
    if (!isThemeId(id)) throw new Error('themes:write: bad theme id');
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      throw new Error('themes:write: theme must be a string under 64 KB');
    }
    await this.ensureDir();
    // Write-then-rename so the watcher (or an editor) never sees half a file.
    const tmp = join(this.dir, `.${id}.json.tmp`);
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, join(this.dir, `${id}.json`));
  }

  // The renderer asks the user to confirm first.
  async remove(id: unknown): Promise<void> {
    if (!isThemeId(id)) throw new Error('themes:remove: bad theme id');
    await rm(join(this.dir, `${id}.json`), { force: true });
  }

  // Calls onChange (debounced) whenever a theme file changes on disk.
  async watch(onChange: () => void): Promise<void> {
    await this.ensureDir();
    this.watcher?.close();
    this.watcher = watch(this.dir, (_event, name) => {
      if (name && (name.startsWith('.') || !name.toLowerCase().endsWith('.json'))) return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(onChange, 150);
    });
    this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) clearTimeout(this.debounce);
  }
}
