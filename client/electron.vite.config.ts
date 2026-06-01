import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import preact from '@preact/preset-vite';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Vite hardcodes `crossorigin` on every emitted `<script type="module">`
// and `<link rel="stylesheet">` tag. Useful when assets are served over
// HTTP, but under Electron's `file://` load it makes Chromium treat
// every asset request as a CORS fetch with a null origin — which fails
// outright, leaving the app booted with no JS modules or styles loaded.
// Strip the attribute at the HTML-emit stage; everything else about the
// build (module-preload, hashed filenames, etc.) is left intact.
function stripCrossOriginAttr(): Plugin {
  return {
    name: 'strip-crossorigin-attr',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:=("|')[^"']*\1)?/g, '');
    },
  };
}

// Dev-only: synthesize the `window.bosonEngine` preload bridge by
// reading the engine discovery file ($XDG_RUNTIME_DIR/boson/engine.json
// or $HOME/.boson/engine.json) on every page load. In packaged
// Electron, the real preload bridge serves this — but in `npm run dev`
// (or `dev:renderer-only`) there's no preload, so the renderer falls
// back to VITE_ENGINE_URL/TOKEN from `.env`. That env was being read
// once per Vite-server startup, so every time Electron's spawned
// sidecar engine respawned on a new ephemeral port the renderer got
// stuck on "Reconnecting to last server…" with a stale URL.
//
// This plugin re-reads engine.json on each `transformIndexHtml` call
// (which fires per page load in dev) and injects a synthetic
// `window.bosonEngine.discovery()` that returns the fresh values.
// Ctrl+R becomes the recovery — no more `make engine-env`.
//
// Skipped during `npm run build` since the packaged renderer gets the
// real bridge from electron preload.
function injectFreshEngineDiscovery(): Plugin {
  return {
    name: 'inject-fresh-engine-discovery',
    apply: 'serve',
    transformIndexHtml(html: string) {
      const candidates: string[] = [];
      if (process.env.XDG_RUNTIME_DIR) {
        candidates.push(join(process.env.XDG_RUNTIME_DIR, 'boson', 'engine.json'));
      }
      candidates.push(join(homedir(), '.boson', 'engine.json'));

      let discovery: { url: string; token: string } | null = null;
      for (const path of candidates) {
        try {
          const parsed = JSON.parse(readFileSync(path, 'utf8'));
          if (typeof parsed.url === 'string' && typeof parsed.token === 'string') {
            discovery = { url: parsed.url, token: parsed.token };
            break;
          }
        } catch {
          // File missing or unparseable — try the next candidate.
        }
      }
      if (!discovery) return html; // engine not running, fall back to .env

      // The renderer's resolveEngineDiscovery (src/main.tsx) calls
      // window.bosonEngine?.discovery() first and falls through to
      // import.meta.env only when null is returned.
      //
      // CRITICAL: only install the synthetic bridge when the REAL
      // preload bridge isn't already there. In full Electron dev
      // (`make client-dev`) the preload script runs first and
      // exposes the live sidecar-engine port + token via
      // contextBridge. Overriding it with this disk-read variant
      // breaks the renderer when engine.json is stale (e.g. a
      // `make engine-serve` invocation that wrote then died — pid
      // in file no longer alive). The `??=` ensures the real
      // bridge wins; the synthetic only fills in for
      // `dev:renderer-only` (plain browser, no preload) where the
      // file is the only source of truth.
      const scriptBody =
        `window.bosonEngine ??= { discovery: async () => (${JSON.stringify(discovery)}) };`;

      // The renderer's index.html ships a CSP meta tag with
      // `default-src 'self'` and no explicit `script-src` — which
      // blocks inline scripts. Compute the SHA-256 of our script
      // body and add it to the CSP as `'sha256-<base64>'` so the
      // browser permits this exact bytes-for-bytes script and no
      // others. The hash changes with the discovery payload, which
      // is fine because we re-emit on every page load anyway.
      const scriptHash = createHash('sha256').update(scriptBody).digest('base64');
      const cspHashSource = `'sha256-${scriptHash}'`;

      // Splice the hash into the existing CSP meta tag's content.
      // The current CSP only sets default-src; we add an explicit
      // script-src that allows self + our specific hash. If a
      // future CSP edit adds an explicit script-src, this still
      // works because the regex matches both shapes.
      //
      // Two variants because the attribute can be single- or
      // double-quoted, and we can't use `[^"']` for the body
      // (CSP values contain single quotes like 'self' and
      // 'unsafe-inline'). Pin the body's terminator to the
      // attribute's actual delimiter via backreference.
      let rewritten = html;
      for (const delim of ['"', "'"]) {
        const rx = new RegExp(
          // <meta ... http-equiv="Content-Security-Policy" ... content="...body..."
          // (delim is whichever quote the meta-tag is using; the
          // body cannot contain that same character.)
          `(<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+content=${delim})([^${delim}]*?)(${delim})`,
          'i',
        );
        const replaced = rewritten.replace(rx, (_match, prefix, body, suffix) => {
          const trimmed = body.trim();
          if (/\bscript-src\b/i.test(trimmed)) {
            // Existing script-src directive — append the hash to it.
            return prefix + trimmed.replace(
              /(\bscript-src\b[^;]*)/i,
              `$1 ${cspHashSource}`,
            ) + suffix;
          }
          // No explicit script-src — append a new directive that
          // allows self + the hash. Browsers fall back to
          // default-src ONLY when script-src is absent, so adding
          // this directive narrows from default-src's restrictions
          // to "self + this exact inline script."
          const sep = trimmed.endsWith(';') ? ' ' : '; ';
          return prefix + trimmed + sep + `script-src 'self' ${cspHashSource};` + suffix;
        });
        if (replaced !== rewritten) {
          rewritten = replaced;
          break;
        }
      }

      // Inject the script tag right before </head>. We do this via
      // string splice instead of the `tags:` descriptor return so
      // the CSP-rewrite + script-inject are atomic.
      const tag = `<script>${scriptBody}</script>`;
      rewritten = rewritten.replace(/<\/head>/i, `${tag}</head>`);
      return rewritten;
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    plugins: [preact(), stripCrossOriginAttr(), injectFreshEngineDiscovery()],
  },
});
