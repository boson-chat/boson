import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every dropdown is the design system's Select (packages/shared/src/
// design-system/Select): a native <select> can't take the theme, opens the
// OS's own list on every platform, and looks different in each. This keeps
// one from coming back.
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const DIRS = [join(ROOT, 'client', 'src'), join(ROOT, 'packages', 'shared', 'src')];
const SELF = __filename;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'gen' || name === 'dist') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(tsx?|jsx?|html)$/.test(name) && p !== SELF) {
      out.push(p);
    }
  }
  return out;
}

// JSX / HTML <select …>, a created one, or h('select'): outside comments.
const NATIVE = [/<select(?=[\s>/]|$)/, /createElement\(\s*['"`]select['"`]/, /\bh\(\s*['"`]select['"`]/];

function nativeSelects(): string[] {
  const hits: string[] = [];
  for (const file of DIRS.flatMap(sourceFiles)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (/^\s*\*/.test(code)) return;
      if (NATIVE.some((re) => re.test(code))) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

describe('no native <select>', () => {
  it('scans both source trees (guards the scan itself)', () => {
    const files = DIRS.flatMap(sourceFiles).map((f) => relative(ROOT, f));
    expect(files).toContain('packages/shared/src/design-system/Select/Select.tsx');
    expect(files).toContain('client/src/renderer/src/screens/UserSettings/VoiceSettings.tsx');
  });

  it('the patterns catch a select', () => {
    expect(NATIVE.some((re) => re.test('    <select'))).toBe(true);
    expect(NATIVE.some((re) => re.test('<select class="x">'))).toBe(true);
    expect(NATIVE.some((re) => re.test("document.createElement('select')"))).toBe(true);
    expect(NATIVE.some((re) => re.test('<Select size="sm"'))).toBe(false);
    expect(NATIVE.some((re) => re.test('<selection>'))).toBe(false);
  });

  it('client/src and packages/shared/src use the design system Select, never <select>', () => {
    expect(nativeSelects(), 'use Select from @boson/shared instead').toEqual([]);
  });
});
