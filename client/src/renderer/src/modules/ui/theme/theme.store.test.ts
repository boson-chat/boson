import { describe, it, expect, beforeEach } from 'vitest';
import { ThemeStore, themeIdFor, type ThemeFilesBridge } from './theme.store';
import { BUILTIN_THEMES } from './themes.builtin';
import { serializeTheme } from './theme.parse';
import type { Theme } from './theme.types';

function fakeBridge(files: Record<string, string> = {}) {
  let listener: (() => void) | null = null;
  const bridge: ThemeFilesBridge & { files: Record<string, string>; fire(): void } = {
    files,
    list: async () => Object.entries(files).map(([id, text]) => ({ id, text })),
    write: async (id, text) => { files[id] = text; },
    remove: async (id) => { delete files[id]; },
    openFolder: async () => {},
    onChange: (fn) => { listener = fn; return () => { listener = null; }; },
    fire: () => listener?.(),
  };
  return bridge;
}

const nord = BUILTIN_THEMES.find((b) => b.id === 'nord')!.theme;
const mine: Theme = { ...nord, name: 'Mine', colors: { ...nord.colors, accent: '#ff0066' } };
const prop = (el: HTMLElement, name: string): string => el.style.getPropertyValue(name);

beforeEach(() => { localStorage.clear(); });

describe('ThemeStore', () => {
  it('applies the default theme to the root', async () => {
    const root = document.createElement('div');
    await new ThemeStore(null, root).init();
    expect(prop(root, '--bg')).toBe('#070709');
    expect(prop(root, '--nick-l')).toBe('64%');
    expect(root.dataset['themeBase']).toBe('dark');
  });

  it("applies an OS look's corners and system font, and restores Boson's on the way back", async () => {
    const root = document.createElement('div');
    const store = new ThemeStore(null, root);
    await store.init();
    store.setActive('macos-dark');
    expect([prop(root, '--radius-sm'), prop(root, '--radius-md'), prop(root, '--radius-lg')]).toEqual(['5px', '10px', '15px']);
    expect(prop(root, '--font-body')).toContain('-apple-system');
    expect(prop(root, '--font-body')).toContain('Segoe UI');
    store.setActive('terminal');
    expect(prop(root, '--radius-sm')).toBe('2px');
    expect(prop(root, '--font-display')).toContain('JetBrains Mono');
  });

  it('remembers the active theme across instances', async () => {
    const root = document.createElement('div');
    new ThemeStore(null, root).setActive('daylight');
    await new ThemeStore(null, root).init();
    expect(root.dataset['themeBase']).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });

  it('saves a custom theme to the folder, activates it, and reads it back', async () => {
    const bridge = fakeBridge();
    const root = document.createElement('div');
    const store = new ThemeStore(bridge, root);
    await store.init();
    const id = await store.save(mine);
    expect(id).toBe('mine');
    expect(JSON.parse(bridge.files['mine']!).colors.accent).toBe('#ff0066');
    expect(store.getState().activeId).toBe('mine');
    expect(prop(root, '--accent')).toBe('#ff0066');

    // A fresh start paints it from the local copy before the folder loads.
    const again = new ThemeStore(fakeBridge(), document.createElement('div'));
    expect(again.getState().activeId).toBe('mine');
  });

  it('picks the file the user edited up live, and reports broken files', async () => {
    const bridge = fakeBridge({ mine: serializeTheme(mine) });
    const root = document.createElement('div');
    const store = new ThemeStore(bridge, root);
    await store.init();
    store.setActive('mine');

    bridge.files['mine'] = serializeTheme({ ...mine, colors: { ...mine.colors, accent: '#00ff00' } });
    bridge.files['broken'] = '{ not json';
    bridge.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(prop(root, '--accent')).toBe('#00ff00');
    expect(store.getState().fileErrors.map((e) => e.id)).toEqual(['broken']);
  });

  it('falls back to the default when the active file disappears, and back when it returns', async () => {
    const bridge = fakeBridge({ mine: serializeTheme(mine) });
    const root = document.createElement('div');
    const store = new ThemeStore(bridge, root);
    await store.init();
    store.setActive('mine');
    const text = bridge.files['mine']!;
    delete bridge.files['mine'];
    await store.reload();
    expect(store.getState().activeId).toBe('terminal');
    bridge.files['mine'] = text;
    await store.reload();
    expect(store.getState().activeId).toBe('mine');
  });

  it('previews without saving, and drops the preview on null', async () => {
    const root = document.createElement('div');
    const store = new ThemeStore(null, root);
    await store.init();
    store.setPreview(mine);
    expect(prop(root, '--accent')).toBe('#ff0066');
    store.setPreview(null);
    expect(prop(root, '--accent')).toBe('#D97706');
    expect(store.getState().themes.some((t) => t.theme.name === 'Mine')).toBe(false);
  });

  it('never overwrites a built-in, and edits a custom theme in place', async () => {
    const bridge = fakeBridge();
    const store = new ThemeStore(bridge, document.createElement('div'));
    await store.init();
    expect(await store.save({ ...nord, name: 'Nord' }, 'nord')).toBe('nord-2');
    expect(await store.save({ ...mine, name: 'Renamed' }, 'nord-2')).toBe('nord-2');
    expect(Object.keys(bridge.files)).toEqual(['nord-2']);
    await store.remove('nord-2');
    expect(bridge.files).toEqual({});
  });
});

describe('themeIdFor', () => {
  it('slugs names and avoids taken ids', () => {
    expect(themeIdFor('My Nord!', () => false)).toBe('my-nord');
    expect(themeIdFor('Ünïcode ✨', () => false)).toBe('unicode');
    expect(themeIdFor('!!!', () => false)).toBe('theme');
    const taken = new Set(['a', 'a-2']);
    expect(themeIdFor('a', (id) => taken.has(id))).toBe('a-3');
  });
});
