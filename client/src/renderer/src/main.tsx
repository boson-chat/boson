import { render } from 'preact';
import { App, buildApp } from './app';
import type { WebSocketCtor } from './modules/engine';
import { isWailsPage } from './platform/is-wails';
import { initDeepLinkBridge } from './modules/deep-link/deep-link';
import { installDropGuard } from './shared/drop-guard';
import { trackVisualViewport } from './shared/visual-viewport';
import { NetworkThemes, getThemeStore, setNetworkThemes } from './modules/ui/theme';
import { VoiceController, getVoiceController, guestVoiceId, normalizeAuthUrl, setVoiceController, voiceBridge } from './modules/voice';
import { VideoController, getVideoController, setVideoController, videoBridge } from './modules/video';
import { FriendsController, HttpFriendsApi, setFriendsController } from './modules/friends';
import { openCall } from './screens/ChatLayout/call-shared';
import { NetworkAccounts, netAuthBridge, setNetworkAccounts } from './modules/netauth/network-accounts';
import { loadGuestSession, onGuestChange } from './modules/guest/guest';
import { FilesController, filesBridge, setFiles } from './modules/files';
import { windowSecureStorage } from './shared/secure-storage';
import './styles.css';

// The Wails shell's bridges (platform/wails.ts) are installed asynchronously;
// everything below that reads a window.boson* bridge waits for them. In a
// plain browser (vite dev) there are no bridges, so it all runs now.
// The web build (chat.boson.chat, VITE_BOSON_SHELL=web) installs its own
// browser-backed bridges (platform/web); the branch is dropped from the
// desktop bundle at build time.
const shellReady: Promise<void> | null = import.meta.env.VITE_BOSON_SHELL !== 'web' && isWailsPage()
  ? import('./platform/wails').then((m) => m.installWailsBridges())
  : import.meta.env.VITE_BOSON_SHELL === 'web'
    ? import('./platform/web').then((m) => m.installWebBridges())
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

// Phones: keep the app above the on-screen keyboard (after the bridges, which
// say whether this is the iOS / Android app).
withBridges(() => { trackVisualViewport(); });

// Keep files/links dropped onto the window from navigating it away from the
// app (see shared/drop-guard.ts; main also guards will-navigate).
installDropGuard();

// The boson auth service (accounts, sign-in, tokens) and API. Production
// defaults, so a build made without CI's env (package-ios.sh, a local
// package.sh) talks to them, not to localhost (which the shell's API proxy
// blocks: "Blocked host"); client/.env points dev builds at local ones.
// The web build reads them at runtime (window.bosonWebConfig, from the web
// container's /boson-config.js), so one build serves any stack.
const webCfg = (window as { bosonWebConfig?: { authUrl?: string; apiUrl?: string; directoryUrl?: string } }).bosonWebConfig;
const authUrl = webCfg?.authUrl || (import.meta.env.VITE_AUTH_URL ?? 'https://auth.boson.chat');
const bosonUrl = webCfg?.apiUrl || (import.meta.env.VITE_BOSON_API_URL ?? 'https://api.boson.chat');

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
    directoryUrl: webCfg?.directoryUrl || import.meta.env.VITE_DIRECTORY_URL || undefined,
    // e2e builds of the app (the shell's E2E bridge) count as dev: they
    // browse test directories served on loopback.
    dev: import.meta.env.DEV || 'bosonE2E' in window,
    engineUrl,
    engineToken,
    engineSocket,
  });
  // Accounts on self-hosted networks (desktop app only: the shell finds
  // each network's auth service and lets the proxy reach it).
  const netAccounts = netAuthBridge()
    ? new NetworkAccounts({ mainAuthUrl: authUrl, mainAuth: props.auth, storage: windowSecureStorage, isGuest: () => loadGuestSession() !== null })
    : null;
  setNetworkAccounts(netAccounts);
  // Network themes: found through each network's boson.json / auth config
  // (desktop: the shell's discovery) or its directory listing, applied over
  // the user's theme for the active server.
  setNetworkThemes(new NetworkThemes({
    discover: netAccounts
      ? async (host) => {
        const link = await netAccounts.discover(host).catch(() => null);
        return { brandingUrl: netAccounts.brandingUrlFor(host), authUrl: link?.authUrl };
      }
      : undefined,
    authConfig: (net) => (netAccounts ? netAccounts.config(net) : props.auth.config()),
    apply: (overlay) => getThemeStore().setNetworkOverlay(overlay),
  }));
  // File uploads to each network's files host (desktop app only). The
  // network account's token when signed in there, else a guest token. On a
  // network without one: the app account's files host, as that account.
  if (filesBridge() && netAccounts) {
    const linkOf = (host: string) => netAccounts.linkFor(host);
    setFiles(new FilesController({
      signedIn: (host) => { const l = linkOf(host); return !!l && !!netAccounts.sessionFor(l); },
      accountToken: async (host) => {
        const l = linkOf(host) ?? await netAccounts.discover(host).catch(() => null);
        return l ? netAccounts.ircToken(l) : null;
      },
      homeSignedIn: () => loadGuestSession() === null && !!props.auth.getState().session,
      homeToken: () => props.auth.getToken(),
    }));
  }
  // Voice channels (the app on desktop, iOS and Android: the bridge is
  // absent in a browser).
  const bridge = voiceBridge();
  if (bridge) {
    const mainAuth = normalizeAuthUrl(authUrl);
    const authFor = (a: string) => (netAccounts ? netAccounts.service(a) : props.auth);
    setVoiceController(new VoiceController(bridge, {
      authUrl,
      // A network's voice takes that network's tokens, never boson.chat's.
      voiceToken: (rooms, net) => (net && netAccounts ? netAccounts.service(net).voiceToken(rooms) : props.auth.voiceToken(rooms)),
      knowsAuth: (net) => netAccounts?.getSnapshot().known.some((k) => k.authUrl === net) ?? false,
      // Guests (no account with that network's auth service) join voice
      // under their IRC nick when the service allows it.
      hasAccount: (a) => (a === mainAuth
        ? loadGuestSession() === null && !!props.auth.getState().session
        : !!netAccounts?.sessionFor({ host: '', authUrl: a, main: false })),
      guestVoice: async (a) => (await (netAccounts ? netAccounts.config(a) : props.auth.config())).guest_voice === true,
      guestVoiceToken: (a, nick, rooms) => authFor(a).guestVoiceToken(nick, guestVoiceId(a), rooms),
    }));
    netAccounts?.onLinked((link) => { void getVoiceController()?.recheck(link.host); });
    // Signing in or out anywhere (or into / out of guest mode) can switch a
    // server's voice between account and guest.
    const accessChanged = (): void => { void getVoiceController()?.accessChanged(); };
    let signedIn = !!props.auth.getState().session;
    props.auth.subscribe((st) => {
      if (st.loading || !!st.session === signedIn) return;
      signedIn = !!st.session;
      accessChanged();
    });
    let netSessions = netAccounts?.getSnapshot().sessions;
    netAccounts?.subscribe((snap) => {
      if (snap.sessions === netSessions) return;
      netSessions = snap.sessions;
      accessChanged();
    });
    onGuestChange(accessChanged);
    // Video in voice channels (desktop/video.go): hidden until a call's
    // server offers it.
    const vb = videoBridge();
    if (vb) setVideoController(new VideoController(vb));
  }
  // Friends and private calls on the app's account (its auth service): the
  // event feed rings this app while it's open.
  const friends = new FriendsController({
    api: new HttpFriendsApi(props.auth),
    authUrl,
    signedIn: () => loadGuestSession() === null && !!props.auth.getState().session,
    me: () => props.auth.getState().session?.user.username ?? '',
    onAccessChange: (fn) => {
      const offAuth = props.auth.subscribe(() => fn());
      const offGuest = onGuestChange(fn);
      return () => { offAuth(); offGuest(); };
    },
    voice: getVoiceController,
    video: getVideoController,
    openCall,
  });
  setFriendsController(friends);
  friends.start();
  void netAccounts?.init();
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
