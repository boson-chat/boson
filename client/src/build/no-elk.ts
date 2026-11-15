// Keeps elkjs (EPL-2.0, which can't be combined with Boson's AGPL-3.0 code)
// out of the renderer bundle. mermaid depends on elkjs for its optional ELK
// layouts and lazy-loads it from a chunk of its own, which Vite would
// otherwise emit (~1.5 MB of Eclipse ELK).
//
//   - elkJsAlias points `elkjs` and `elkjs/lib/elk.bundled.js` at a stub, so
//     no elkjs code can reach the bundle whatever mermaid does.
//   - noElkLayouts() drops mermaid's ELK layout registrations
//     (`...elkLayoutLoaders()` in its layout registry) in builds, and
//     noElkLayoutsEsbuild() does the same for the dev server's prebundled
//     mermaid. With no "elk" layout registered, mermaid's
//     getRegisteredLayoutAlgorithm falls back to dagre (as in its own "tiny"
//     build), so `layout: elk` diagrams still render, and mermaid's ELK
//     chunk is never referenced.
//
// mermaid 12's default layout is "elk", so MarkdownDoc also sets
// `layout: 'dagre'` explicitly.
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { Plugin as EsbuildPlugin } from 'esbuild';
import type { Alias, Plugin } from 'vite';

export const elkStubPath = fileURLToPath(new URL('./elkjs-stub.ts', import.meta.url));

export const elkJsAlias: Alias = { find: /^elkjs(\/.*)?$/, replacement: elkStubPath };

const ELK_LOADERS = /\.\.\.elkLayoutLoaders\(\)/g;
const MERMAID_DIST = /[\\/]node_modules[\\/]mermaid[\\/]dist[\\/]/;

// Removes mermaid's ELK layout registrations from one of its modules.
// Returns null when the module has none.
export function stripElkLayouts(code: string): string | null {
  if (!ELK_LOADERS.test(code)) return null;
  ELK_LOADERS.lastIndex = 0;
  return code.replace(ELK_LOADERS, '');
}

export function noElkLayouts(): Plugin {
  let sawMermaid = false;
  let stripped = false;
  return {
    name: 'boson-no-elk-layouts',
    apply: 'build',
    transform(code, id) {
      if (!MERMAID_DIST.test(id)) return null;
      sawMermaid = true;
      const out = stripElkLayouts(code);
      if (out === null) return null;
      stripped = true;
      return { code: out, map: null };
    },
    buildEnd() {
      if (sawMermaid && !stripped) {
        this.warn(
          "mermaid's ELK layout registration (`...elkLayoutLoaders()`) was not found: " +
            '`layout: elk` diagrams will fail with the elkjs stub instead of falling back to dagre. ' +
            'Update client/src/build/no-elk.ts for this mermaid version.',
        );
      }
    },
  };
}

// The same for the dev server, whose dependency optimizer bundles mermaid
// with esbuild (Vite plugins' transform hooks don't run there).
export function noElkLayoutsEsbuild(): EsbuildPlugin {
  return {
    name: 'boson-no-elk-layouts',
    setup(build) {
      build.onLoad({ filter: /[\\/]node_modules[\\/]mermaid[\\/]dist[\\/].*\.mjs$/ }, async (args) => {
        const out = stripElkLayouts(await readFile(args.path, 'utf8'));
        return out === null ? undefined : { contents: out, loader: 'js' };
      });
    },
  };
}
