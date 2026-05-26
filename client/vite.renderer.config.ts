import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'node:path';

// Standalone Vite config for the renderer — used by Playwright (and any other
// browser-only consumer) without launching Electron. The real Electron build
// goes through electron.vite.config.ts.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  envDir: resolve(__dirname), // load client/.env instead of src/renderer/.env
  plugins: [preact()],
  server: { port: 5173, strictPort: true },
});
