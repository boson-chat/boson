import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import preact from '@preact/preset-vite';
import type { Plugin } from 'vite';

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
    plugins: [preact(), stripCrossOriginAttr()],
  },
});
