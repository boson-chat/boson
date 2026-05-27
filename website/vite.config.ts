import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // /discover hits the public IRC-directory list endpoint. In dev we
  // proxy through Vite so the browser's CORS check never trips — the
  // production backend can stay scoped to https://boson.chat as its
  // sole approved web origin. Override with VITE_BOSON_API_URL if you
  // want to point dev at a local Go backend instead.
  const apiUrl = env.VITE_BOSON_API_URL ?? 'https://api.boson.chat';
  return {
    plugins: [preact()],
    server: {
      port: 5174,
      strictPort: false,
      // Allow all hosts — convenient for previewing through ngrok /
      // cloudflared / any tunnel without maintaining an allowlist.
      // Dev only; vite preview and the production build are unaffected.
      allowedHosts: true,
      proxy: {
        '/servers': {
          target: apiUrl,
          changeOrigin: true,
          secure: true,
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: false,
    },
  };
});
