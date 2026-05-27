import { render } from 'preact';
import { App, buildApp } from './app';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? 'http://localhost:54321';
// Supabase migrated from "anon" to "publishable" keys (sb_publishable_...).
// Prefer the new name; fall back to the legacy var so `make client-env`
// (which reads `ANON_KEY` straight from the local Supabase CLI) keeps
// working without renaming anything in the dev stack.
const publishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  '';
const bosonUrl = import.meta.env.VITE_BOSON_API_URL ?? 'http://localhost:3000';

const root = document.getElementById('app')!;

// Engine discovery — in the packaged app the main process spawned the
// bundled engine binary on a random loopback port and exposes the URL +
// token via the bosonEngine preload bridge. In dev (`npm run dev`) the
// bridge returns null and we fall back to VITE_ENGINE_URL/TOKEN from
// .env, which `make engine-env` populates after `make engine-serve`.
async function resolveEngineDiscovery(): Promise<{ url?: string; token?: string }> {
  const bridge = (window as { bosonEngine?: { discovery: () => Promise<{ url: string; token: string } | null> } }).bosonEngine;
  if (bridge) {
    try {
      const d = await bridge.discovery();
      if (d) return { url: d.url, token: d.token };
    } catch (err) {
      console.warn('engine discovery via IPC failed', err);
    }
  }
  return {
    url: import.meta.env.VITE_ENGINE_URL,
    token: import.meta.env.VITE_ENGINE_TOKEN,
  };
}

if (!publishableKey) {
  root.innerHTML =
    '<div style="padding:2rem;color:#fa5252;font-family:system-ui">' +
    'VITE_SUPABASE_PUBLISHABLE_KEY is not set. Run <code>make client-env</code>.' +
    '</div>';
} else {
  void (async () => {
    const { url: engineUrl, token: engineToken } = await resolveEngineDiscovery();
    const props = buildApp({
      supabaseUrl,
      anonKey: publishableKey,
      bosonUrl,
      engineUrl,
      engineToken,
    });
    // Fire init async — App renders immediately and shows "Loading…" until ready.
    props.auth.init().catch((err) => {
      console.error('auth.init failed', err);
      props.auth.markFatal(err instanceof Error ? err.message : String(err));
    });
    if (props.engine) {
      props.engine.open().catch((err) => console.error('engine.open failed', err));
    }
    render(<App {...props} />, root);
  })();
}
