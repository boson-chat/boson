import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5174,
    strictPort: false,
    // Allow all hosts — convenient for previewing through ngrok / cloudflared
    // / any tunnel without maintaining an allowlist. Dev only; vite preview
    // and the production build are unaffected.
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
