// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ELK, { ELK_UNAVAILABLE } from './elkjs-stub';
import { elkJsAlias, stripElkLayouts } from './no-elk';

const require = createRequire(import.meta.url);

describe('no-elk', () => {
  it('aliases elkjs and its bundled entry to the stub', () => {
    const find = elkJsAlias.find as RegExp;
    expect(find.test('elkjs')).toBe(true);
    expect(find.test('elkjs/lib/elk.bundled.js')).toBe(true);
    expect(find.test('elkjs-something')).toBe(false);
    expect(find.test('mermaid')).toBe(false);
  });

  it('strips the ELK layout registrations', () => {
    const code = 'registerLayoutLoaders([{ name: "dagre" }, ...true ? [{ name: "cose" }, ...elkLayoutLoaders()] : []]);';
    expect(stripElkLayouts(code)).toBe('registerLayoutLoaders([{ name: "dagre" }, ...true ? [{ name: "cose" }, ] : []]);');
    expect(stripElkLayouts('no layouts here')).toBeNull();
  });

  // Catches a mermaid upgrade that renames the registration (the build only
  // warns about it).
  it("matches the installed mermaid's layout registry", () => {
    const dist = join(dirname(require.resolve('mermaid')), 'chunks', 'mermaid.core');
    const hits = readdirSync(dist)
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => stripElkLayouts(readFileSync(join(dist, f), 'utf8')) !== null);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('stub rejects layouts with a clear error', async () => {
    await expect(new ELK().layout()).rejects.toThrow(ELK_UNAVAILABLE);
  });
});
