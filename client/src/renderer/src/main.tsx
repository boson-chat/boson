import { render } from 'preact';
import { App, buildApp } from './app';
import type { WebSocketCtor } from './modules/engine';
import { isWailsPage } from './platform/is-wails';
import { initDeepLinkBridge } from './modules/deep-link/deep-link';
import { installDropGuard } from './shared/drop-guard';
import { getThemeStore } from './modules/ui/theme';
import './styles.css';

// The Wails shell's bridges (platform/wails.ts) are installed asynchronously;
// everything below that reads a window.boson* bridge waits for them. In a
// plain browser (vite dev) there are no bridges, so it all runs now.
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

// Attach to the shell's deep-link bridge before any UI mounts so
// the module-level buffer in deep-link.ts captures any `boson://` URL
// the OS hands us, even before the directory screen mounts.
withBridges(initDeepLinkBridge);

// Keep files/links dropped onto the window from navigating it away from the
// app (see shared/drop-guard.ts; main also guards will-navigate).
installDropGuard();

// The boson auth service (accounts, sign-in, tokens). Production default;
// client/.env points dev builds at a local one.
const authUrl = import.meta.env.VITE_AUTH_URL ?? 'https://auth.boson.chat';
const bosonUrl = import.meta.env.VITE_BOSON_API_URL ?? 'http://localhost:3000';

const root = document.getElementById('app')!;

// Engine discovery — in the desktop app the engine runs in-process and
// the bosonEngine bridge (platform/wails.ts) hands back the discovery
// along with the socket class that reaches it. In browser dev (`npm run
// dev`) there's no bridge and we fall back to VITE_ENGINE_URL/TOKEN from
// .env, which `make engine-env` populates after `make engine-serve`.
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

void (async () => {
  if (shellReady) await shellReady;
  const { url: engineUrl, token: engineToken, socket: engineSocket } = await resolveEngineDiscovery();
  const props = buildApp({
    authUrl,
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
  // Email links (verify, reset password) open the auth service's own pages
  // in the browser; nothing comes back to the app over a deep link. After
  // verifying, the user signs in on the login screen.
  render(<App {...props} />, root);
})();
