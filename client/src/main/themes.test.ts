// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ThemeFiles, isThemeId } from './themes';

let root: string;
let files: ThemeFiles;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boson-themes-'));
  files = new ThemeFiles(join(root, 'themes'));
});
afterEach(() => {
  files.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ThemeFiles', () => {
  it('creates the folder with a README on first use', async () => {
    expect(await files.list()).toEqual([]);
    expect(readdirSync(files.dir)).toEqual(['README.txt']);
  });

  it('writes, lists and removes theme files', async () => {
    await files.write('mine', '{"name":"Mine"}');
    writeFileSync(join(files.dir, 'notes.txt'), 'ignored');
    writeFileSync(join(files.dir, 'bad name!.json'), '{}');
    expect(await files.list()).toEqual([{ id: 'mine', text: '{"name":"Mine"}' }]);
    await files.remove('mine');
    expect(existsSync(join(files.dir, 'mine.json'))).toBe(false);
    await files.remove('mine'); // already gone: fine
  });

  it('refuses ids that could leave the folder, and oversized themes', async () => {
    for (const id of ['../x', 'a/b', '', '.hidden', 'x'.repeat(65)]) {
      await expect(files.write(id, '{}')).rejects.toThrow(/bad theme id/);
    }
    await expect(files.write('big', 'x'.repeat(65 * 1024))).rejects.toThrow(/64 KB/);
    await expect(files.remove('../x')).rejects.toThrow(/bad theme id/);
  });

  it('reports a too-large file as such instead of reading it', async () => {
    await files.list();
    writeFileSync(join(files.dir, 'huge.json'), 'x'.repeat(70 * 1024));
    expect(await files.list()).toEqual([{ id: 'huge', text: '"too large"' }]);
  });

  it('notices edits made outside the app', async () => {
    let changes = 0;
    await files.watch(() => { changes++; });
    writeFileSync(join(files.dir, 'live.json'), '{}');
    await new Promise((r) => setTimeout(r, 400));
    expect(changes).toBeGreaterThan(0);
    expect(readFileSync(join(files.dir, 'live.json'), 'utf8')).toBe('{}');
  });
});

describe('isThemeId', () => {
  it('accepts file-name-safe ids only', () => {
    expect(isThemeId('nord-2')).toBe(true);
    expect(isThemeId('My_Theme')).toBe(true);
    expect(isThemeId('-x')).toBe(false);
    expect(isThemeId(3)).toBe(false);
  });
});
