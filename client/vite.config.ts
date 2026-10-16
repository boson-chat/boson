import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The renderer: built into out/renderer, which the desktop app (desktop/)
// embeds; `npm run dev` serves it in a browser on :5173, where it talks to a
// separately running engine (`make engine-serve`) over its WebSocket.

// Dev server only: install a `window.bosonEngine` discovery bridge read
// from the engine's discovery file ($XDG_RUNTIME_DIR/boson/engine.json or
// ~/.boson/engine.json) on every page load, so a restarted
// `make engine-serve` (new port and token) is picked up by a reload. With no
// discovery file the renderer falls back to VITE_ENGINE_URL/TOKEN.
//
// The page's CSP allows no inline scripts, so the script's hash is added to
// it (and recomputed with the payload on every load).
function injectFreshEngineDiscovery(): Plugin {
  return {
    name: 'inject-fresh-engine-discovery',
    apply: 'serve',
    transformIndexHtml(html: string) {
      const candidates: string[] = [];
      if (process.env.XDG_RUNTIME_DIR) candidates.push(join(process.env.XDG_RUNTIME_DIR, 'boson', 'engine.json'));
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
          // Missing or unparseable: try the next one.
        }
      }
      if (!discovery) return html;

      const scriptBody = `window.bosonEngine ??= { discovery: async () => (${JSON.stringify(discovery)}) };`;
      const hash = `'sha256-${createHash('sha256').update(scriptBody).digest('base64')}'`;
      // Splice the hash into the CSP meta tag: into its script-src if it has
      // one, else as a new script-src (self + this script). The attribute's
      // own quote character ends the value; CSP values contain the other.
      let rewritten = html;
      for (const delim of ['"', "'"]) {
        const rx = new RegExp(
          `(<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+content=${delim})([^${delim}]*?)(${delim})`,
          'i',
        );
        const replaced = rewritten.replace(rx, (_m, prefix: string, body: string, suffix: string) => {
          const trimmed = body.trim();
          if (/\bscript-src\b/i.test(trimmed)) {
            return prefix + trimmed.replace(/(\bscript-src\b[^;]*)/i, `$1 ${hash}`) + suffix;
          }
          const sep = trimmed.endsWith(';') ? ' ' : '; ';
          return prefix + trimmed + sep + `script-src 'self' ${hash};` + suffix;
        });
        if (replaced !== rewritten) {
          rewritten = replaced;
          break;
        }
      }
      return rewritten.replace(/<\/head>/i, `<script>${scriptBody}</script></head>`);
    },
  };
}

// Coverage builds for the real-app e2e suite (E2E_COVERAGE=1) keep source
// maps and skip minifying, so V8 coverage maps back onto src/ lines.
const coverageBuild = process.env['E2E_COVERAGE'] === '1';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  envDir: resolve(__dirname), // client/.env, not src/renderer/.env
  plugins: [preact(), injectFreshEngineDiscovery()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: resolve(__dirname, process.env['RENDERER_OUT_DIR'] || 'out/renderer'),
    emptyOutDir: true,
    ...(coverageBuild ? { sourcemap: true, minify: false } : {}),
  },
});
