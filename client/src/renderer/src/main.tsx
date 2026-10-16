import { render } from 'preact';
import { App, buildApp } from './app';
import type { WebSocketCtor } from './modules/engine';
import { isWailsPage } from './platform/is-wails';
import { initDeepLinkBridge, subscribeAuthConfirmed } from './modules/deep-link/deep-link';
import { installDropGuard } from './shared/drop-guard';
import { getThemeStore } from './modules/ui/theme';
import './styles.css';

// The Wails shell's bridges (platform/wails.ts) are installed asynchronously;
// everything below that reads a window.boson* bridge waits for them. Under
// Electron the preload has already installed them, so it all runs now.
const shellReady: Promise<void> | null = isWailsPage()
  ? import('./platform/wails').then((m) => m.installWailsBridges())
  : null;

function withBridges(fn: () => void): void {
  if (shellReady) void shellReady.then(fn);
  else fn();
}

// Paint the saved theme before anything renders (from the local copy), then
// load the themes folder and watch it for edits.
withBridges(() => { void getThemeStore().init(); });

// Attach to the main-process deep-link bridge before any UI mounts so
// the module-level buffer in deep-link.ts captures any `boson://` URL
// the OS hands us, even before the directory screen mounts.
withBridges(initDeepLinkBridge);

// Keep files/links dropped onto the window from navigating it away from the
// app (see shared/drop-guard.ts; main also guards will-navigate).
installDropGuard();

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
// Under Wails the engine is in-process and the discovery also carries the
// socket class that reaches it (platform/wails.ts).
async function resolveEngineDiscovery(): Promise<{ url?: string; token?: string; socket?: WebSocketCtor }> {
  const bridge = (window as { bosonEngine?: { discovery: () => Promise<{ url: string; token: string; socket?: WebSocketCtor } | null> } }).bosonEngine;
  if (bridge) {
    try {
      const d = await bridge.discovery();
      if (d) return { url: d.url, token: d.token, socket: d.socket };
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
    if (shellReady) await shellReady;
    const { url: engineUrl, token: engineToken, socket: engineSocket } = await resolveEngineDiscovery();
    const props = buildApp({
      supabaseUrl,
      anonKey: publishableKey,
      bosonUrl,
      engineUrl,
      engineToken,
      engineSocket,
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
      // Login-CSRF guard: only hydrate if the deep-link carries the one-time
      // state nonce we minted when starting this flow. A forged
      // boson://auth/confirmed from an arbitrary web page won't know it, so
      // it can't inject an attacker's Supabase session into the running app.
      const expected = props.auth.consumeDeepLinkState();
      if (!expected || params.state !== expected) {
        console.warn('[auth-confirmed] rejected: missing or mismatched state nonce (possible login CSRF)');
        return;
      }
      console.info('[auth-confirmed] hydrating session', {
        kind: params.code ? 'pkce-code' : params.accessToken ? 'implicit-tokens' : 'empty',
        type: params.type,
      });
      const tryHydrate = async (): Promise<void> => {
        if (params.code) {
          await props.auth.exchangeAuthCode(params.code);
          console.info('[auth-confirmed] exchangeAuthCode succeeded');
          return;
        }
        if (params.accessToken && params.refreshToken) {
          await props.auth.setSessionFromTokens(params.accessToken, params.refreshToken);
          console.info('[auth-confirmed] setSessionFromTokens succeeded');
          return;
        }
        console.warn('[auth-confirmed] no usable params (no code, no accessToken+refreshToken)');
      };
      tryHydrate().catch((err) => {
        console.error('[auth-confirmed] hydration failed', err);
        props.auth.markFatal(err instanceof Error ? err.message : String(err));
      });
    });
    render(<App {...props} />, root);
  })();
}
