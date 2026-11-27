// The web build's shell (chat.boson.chat): installs the window.boson*
// bridges the renderer reaches platform features through, as
// platform/wails.ts does for the desktop and phone apps, backed by browser
// APIs instead of Go services. Loaded (dynamically, from main.tsx) only in
// a web build. What isn't here falls back to the renderer's own browser
// behaviour (direct fetch, local-storage themes, Web Notifications), or is
// unavailable on the web (docs/web-client.md).
import wasmUrl from 'boson-engine-wasm?url';
import { gatewayUrl, homeNetworkOf, webConfig } from './config';
import { setHomeNetwork, updateHomeNetwork } from '../../modules/netauth/home-network';
import { webDeepLinkBridge } from './deep-link';
import { WebEngine } from './engine';
import { createWebSecureStore } from './secure-store';
import { webSSOBridge } from './sso';
import { installWebE2E } from './e2e';
import { installCalls } from './calls';
import { NetworkDiscoverer, setNetworkDiscoverer } from './discovery';
import { webNetAuthBridge } from './netauth';
import { webFilesBridge } from './files';
import { webBrandingBridge } from './branding';
import { webUnfurlBridges } from './unfurl';
import { webPushBridge } from './push';
import type { PushSubscriptionInfo } from '../../modules/push/push.types';

function originOf(u: string | undefined): string {
  try { return u ? new URL(u).origin : ''; } catch { return ''; }
}

export async function installWebBridges(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  const cfg = webConfig();
  // The renderer checks this for what the web build does differently (no
  // window controls, the About row).
  w.bosonShell = 'web';

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

  // Networks' boson.json (sign-in, themes, uploads, voice). e2e builds
  // reach loopback http and take documents for domain-less hosts from the
  // test (BOSON_NETWORK_JSON).
  const e2eEnv = (window as unknown as { bosonWebE2EEnv?: { networkJson?: string[]; voiceJson?: string[]; certInfo?: Record<string, string> } }).bosonWebE2EEnv;
  const dev = !!cfg.e2e;
  const discoverer = new NetworkDiscoverer({ allowLoopbackHttp: dev, overrides: dev ? e2eEnv?.networkJson ?? [] : [] });
  setNetworkDiscoverer(discoverer);
  const mainAuthUrl = cfg.authUrl || import.meta.env.VITE_AUTH_URL || 'https://auth.boson.chat';
  // Whose web client this is: boson.chat's, or a self-hosted network's,
  // which is then the app's own network (its account is the main one, its
  // IRC server the one the app starts on: its boson.json irc, which on the
  // stack is the gateway's route to the network's bouncer bridge).
  const home = homeNetworkOf(cfg, mainAuthUrl);
  setHomeNetwork(home);
  if (home.selfHosted) {
    void discoverer.home(home.domain, mainAuthUrl).then((d) => {
      // Only the document that names this client's auth service as its own.
      if (!d.auth || originOf(d.auth) !== originOf(mainAuthUrl)) {
        console.warn(`home network: ${home.domain}'s boson.json doesn't name ${mainAuthUrl} as its auth service`);
      } else if (d.irc?.host && !/[/@\s]/.test(d.irc.host)) {
        updateHomeNetwork({ irc: { host: d.irc.host, port: d.irc.port || 6697, tls: d.irc.tls } });
      } else {
        console.warn(`home network: ${home.domain}'s boson.json names no IRC server`);
      }
    }).catch((err) => console.warn('home network: discovery failed', err));
  }
  const apiUrl = cfg.apiUrl || import.meta.env.VITE_BOSON_API_URL || 'https://api.boson.chat';
  const appOrigins = [
    originOf(apiUrl),
    originOf(cfg.directoryUrl || import.meta.env.VITE_DIRECTORY_URL || 'https://directory.boson.chat'),
  ].filter(Boolean);
  w.bosonNetAuth = webNetAuthBridge({ discoverer, mainAuthUrl, appOrigins });
  w.bosonFiles = webFilesBridge({ discoverer, mainAuthUrl, appOrigins });
  w.bosonBranding = webBrandingBridge(dev);

  // Link previews and Spotify cards, fetched by the boson API (its
  // /v1/unfurl; desktop: the Go shell).
  const unfurl = webUnfurlBridges(apiUrl);
  w.bosonUnfurl = unfurl.unfurl;
  w.bosonSpotify = unfurl.spotify;
  // YouTube's player is framed by the wrapper page (public/youtube-embed.html)
  // on the app's own origin, as the desktop frames boson.chat's copy: it
  // passes on the player's errors, so a video YouTube won't play here
  // becomes the card that opens it on YouTube.
  w.bosonYouTube = { wrapperOrigin: location.origin };

  // Push notifications through the browser's push service, one service
  // worker per server (push.ts, push-sw.ts; docs/push.md §3).
  // e2e builds: a subscription from the test instead of the browser's push
  // service (headless browsers get none); the worker is still registered.
  const e2ePush = (window as unknown as { bosonWebE2EEnv?: { BOSON_E2E_PUSH_SUBSCRIPTION?: string } }).bosonWebE2EEnv?.BOSON_E2E_PUSH_SUBSCRIPTION;
  w.bosonPush = webPushBridge({
    base: document.baseURI,
    ...(cfg.e2e && e2ePush ? { fakeSubscription: JSON.parse(e2ePush) as PushSubscriptionInfo } : {}),
  });

  // Ask the browser to keep this origin's storage (history, the secure
  // store) under storage pressure. Best-effort; no prompt in most browsers.
  void navigator.storage?.persist?.().catch(() => {});

  if (cfg.e2e) installWebE2E(w, { deliverDeepLink: deepLink.deliver, engine });

  // Voice and video channels (WebTransport). Dev/e2e builds take test
  // networks' boson.json documents and self-signed servers' cert info from
  // the e2e launcher (tests/e2e-app/web-app.ts).
  await installCalls(w, {
    authBase: mainAuthUrl,
    dev,
    networkJson: dev ? [...(e2eEnv?.networkJson ?? []), ...(e2eEnv?.voiceJson ?? [])] : undefined,
    certInfo: dev ? e2eEnv?.certInfo : undefined,
  }).catch((err) => console.warn('calls: not available', err));

  // Last: everything above is in place (e2e launches wait for this).
  w.bosonShellReady = true;
}
