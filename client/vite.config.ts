import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { build as esbuild } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { elkJsAlias, noElkLayouts, noElkLayoutsEsbuild } from './src/build/no-elk';

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

// The web build (chat.boson.chat; `npm run build:web`): the same renderer
// with platform/web's browser bridges and the engine as WebAssembly. Its
// CSP comes from the server that serves it (the web container sets the
// stack's hosts), so the desktop's meta CSP is dropped; /boson-config.js
// (runtime settings, rewritten by the container) loads before the app.
const webBuild = process.env['VITE_BOSON_SHELL'] === 'web';
// Coverage builds for the real-app e2e suite (E2E_COVERAGE=1) keep source
// maps and skip minifying, so V8 coverage maps back onto src/ lines.
const coverageBuild = process.env['E2E_COVERAGE'] === '1';
const webGen = resolve(__dirname, 'src/renderer/src/platform/web/gen');

function webShell(): Plugin {
  return {
    name: 'boson-web-shell',
    apply: () => webBuild,
    transformIndexHtml(html: string) {
      return html
        .replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '')
        .replace(/(<script type="module")/, '<script src="./boson-config.js"></script>\n    $1');
    },
    async generateBundle() {
      // The push service worker (platform/web/push-sw.ts): its own bundle at
      // a fixed name, since its URL is its identity (and sets its scope).
      const sw = await esbuild({
        entryPoints: [resolve(__dirname, 'src/renderer/src/platform/web/push-sw.ts')],
        bundle: true, write: false, format: 'iife', target: 'es2020', minify: !coverageBuild,
      });
      this.emitFile({ type: 'asset', fileName: 'push-sw.js', source: sw.outputFiles[0]!.text });
      // Defaults from the build's env; the web container overwrites it.
      const cfg = {
        authUrl: process.env['VITE_AUTH_URL'] || undefined,
        apiUrl: process.env['VITE_BOSON_API_URL'] || undefined,
        directoryUrl: process.env['VITE_DIRECTORY_URL'] || undefined,
        gatewayUrl: process.env['VITE_WEB_GATEWAY_URL'] || undefined,
      };
      this.emitFile({
        type: 'asset',
        fileName: 'boson-config.js',
        source: `window.bosonWebConfig = ${JSON.stringify(cfg)};\n`,
      });
      // The YouTube wrapper the app frames (the desktop's copy is in the
      // renderer's public/; platform/web/index.ts, infra/web/nginx.conf).
      for (const f of ['youtube-embed.html', 'youtube-embed.js']) {
        this.emitFile({ type: 'asset', fileName: f, source: readFileSync(resolve(__dirname, 'src/renderer/public', f)) });
      }
    },
  };
}


export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  envDir: resolve(__dirname), // client/.env, not src/renderer/.env
  plugins: [preact(), injectFreshEngineDiscovery(), noElkLayouts(), webShell()],
  // elkjs (EPL-2.0) never reaches the bundle: see src/build/no-elk.ts.
  resolve: {
    alias: [
      elkJsAlias,
      // Only the web build has the web shell (and needs its generated engine).
      ...(webBuild ? [] : [{ find: /^\.\/platform\/web$/, replacement: resolve(__dirname, 'src/renderer/src/platform/web-stub.ts') }]),
      { find: /^boson-engine-wasm/, replacement: join(webGen, 'engine.wasm') },
      { find: /^boson-wasm-exec$/, replacement: join(webGen, 'wasm_exec.js') },
    ],
  },
  publicDir: webBuild ? resolve(__dirname, 'web/public') : 'public',
  worker: { format: 'es' },
  optimizeDeps: { esbuildOptions: { plugins: [noElkLayoutsEsbuild()] } },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: resolve(__dirname, process.env['RENDERER_OUT_DIR'] || (webBuild ? 'out/web' : 'out/renderer')),
    emptyOutDir: true,
    ...(coverageBuild ? { sourcemap: true, minify: false } : {}),
  },
});
