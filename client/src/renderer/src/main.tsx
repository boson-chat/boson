import { render } from 'preact';
import { App, buildApp } from './app';
import { initDeepLinkBridge, subscribeAuthConfirmed } from './modules/deep-link/deep-link';
import './styles.css';

// Attach to the main-process deep-link bridge before any UI mounts so
// the module-level buffer in deep-link.ts captures any `boson://` URL
// the OS hands us, even before the directory screen mounts.
initDeepLinkBridge();

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
    // Email-confirmation deep-links arrive via the boson://auth/confirmed
    // URL after the user clicks the link in the Supabase confirmation
    // email. We hydrate the Supabase session from the tokens (or the
    // PKCE code) here so the app drops them straight into the
    // post-signup landing screen.
    subscribeAuthConfirmed((params) => {
      const tryHydrate = async (): Promise<void> => {
        if (params.code) {
          await props.auth.exchangeAuthCode(params.code);
          return;
        }
        if (params.accessToken && params.refreshToken) {
          await props.auth.setSessionFromTokens(params.accessToken, params.refreshToken);
          return;
        }
      };
      tryHydrate().catch((err) => {
        console.error('auth-confirmed hydration failed', err);
        props.auth.markFatal(err instanceof Error ? err.message : String(err));
      });
    });
    render(<App {...props} />, root);
  })();
}
