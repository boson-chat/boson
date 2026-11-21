// The web build's shell (chat.boson.chat): installs the window.boson*
// bridges the renderer reaches platform features through, as
// platform/wails.ts does for the desktop and phone apps, backed by browser
// APIs instead of Go services. Loaded (dynamically, from main.tsx) only in
// a web build. What isn't here falls back to the renderer's own browser
// behaviour (direct fetch, local-storage themes, Web Notifications), or is
// unavailable on the web (docs/web-client.md).
import wasmUrl from 'boson-engine-wasm?url';
import { gatewayUrl, webConfig } from './config';
import { webDeepLinkBridge } from './deep-link';
import { WebEngine } from './engine';
import { createWebSecureStore } from './secure-store';
import { webSSOBridge } from './sso';
import { installWebE2E } from './e2e';
import { installCalls } from './calls';

export async function installWebBridges(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  const cfg = webConfig();

  const engine = new WebEngine({
    wasmUrl,
    gatewayUrl: gatewayUrl(cfg),
    createWorker: () => new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'boson-engine' }),
  });
  // Start loading the engine while the rest of the app boots.
  void engine.start().catch((err) => console.warn('engine: failed to start', err));
  const socket = engine.socketClass();
  w.bosonEngine = { discovery: async () => ({ url: 'web:engine', token: 'in-page', socket }) };

  w.bosonSecure = createWebSecureStore();

  const deepLink = webDeepLinkBridge();
  w.bosonDeepLink = { consume: deepLink.consume, onJoin: deepLink.onJoin };

  w.bosonSSO = webSSOBridge();

  // Ask the browser to keep this origin's storage (history, the secure
  // store) under storage pressure. Best-effort; no prompt in most browsers.
  void navigator.storage?.persist?.().catch(() => {});

  if (cfg.e2e) installWebE2E(w, { deliverDeepLink: deepLink.deliver });

  // Voice and video channels (WebTransport). Dev/e2e builds take test
  // networks' boson.json documents and self-signed servers' cert info from
  // the e2e launcher (tests/e2e-app/web-app.ts).
  const e2eEnv = (window as { bosonWebE2EEnv?: { networkJson?: string[]; certInfo?: Record<string, string> } }).bosonWebE2EEnv;
  const dev = !!cfg.e2e || /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
  await installCalls(w, {
    authBase: cfg.authUrl || import.meta.env.VITE_AUTH_URL || 'https://auth.boson.chat',
    dev,
    networkJson: dev ? e2eEnv?.networkJson : undefined,
    certInfo: dev ? e2eEnv?.certInfo : undefined,
  }).catch((err) => console.warn('calls: not available', err));

  // Last: everything above is in place (e2e launches wait for this).
  w.bosonShell = 'web';
  w.bosonShellReady = true;
}
