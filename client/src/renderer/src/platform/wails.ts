// The Wails desktop shell. Loaded (dynamically, from main.tsx) only when the
// page is served by Wails, so the Electron and browser builds never pull in
// the Wails runtime. It installs the same window.boson* bridges the Electron
// preload exposes, backed by Go services in desktop/.

import { Call, Events, System, Window } from '@wailsio/runtime';
import type { WebSocketLike } from '../modules/engine/engine.client';
import type { ApiRequest, ApiResponse } from '../shared/http/transport';

const ENGINE = 'main.EngineService';
const STORE = 'main.SecureStore';
const THEMES = 'main.ThemesService';
const UPDATER = 'main.UpdaterService';

// The engine runs in the Wails process. This stands in for the WebSocket the
// engine client would otherwise open: frames go out through a binding and
// come back as events, carrying the same JSON protocol.
class WailsEngineSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  private off: (() => void) | null = null;

  constructor(_url: string) {
    this.off = Events.On('engine:frame', (ev) => {
      if (this.readyState !== 1) return;
      this.onmessage?.call(this, new MessageEvent('message', { data: ev.data as string }));
    });
    Call.ByName(`${ENGINE}.Open`).then(
      () => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.call(this, new Event('open'));
      },
      () => this.fail(),
    );
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    Call.ByName(`${ENGINE}.Send`, data).catch(() => this.fail());
  }

  close(): void {
    if (this.readyState >= 2) return;
    void Call.ByName(`${ENGINE}.Close`).catch(() => {});
    this.finish();
  }

  private fail(): void {
    if (this.readyState >= 2) return;
    this.onerror?.call(this, new Event('error'));
    this.finish();
  }

  private finish(): void {
    this.readyState = 3;
    this.off?.();
    this.off = null;
    this.onclose?.call(this, new CloseEvent('close'));
  }
}

// API requests go through the Go proxy (desktop/apiproxy.go): the page's
// origin isn't one api.boson.chat's CORS allows. A binary body crosses the
// bridge as base64.
async function apiFetch(req: ApiRequest): Promise<ApiResponse> {
  const { body, ...rest } = req;
  const wire: Record<string, unknown> = { ...rest };
  if (typeof body === 'string') wire.body = body;
  else if (body instanceof ArrayBuffer) wire.bodyBase64 = toBase64(body);
  return Call.ByName('main.ApiService.Fetch', wire) as Promise<ApiResponse>;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Window controls for the renderer's own title bar (Windows/Linux draw
// min/max/close; macOS keeps the native traffic lights).
const windowBridge = {
  minimize: () => Window.Minimise(),
  toggleMaximize: () => Window.ToggleMaximise(),
  close: () => Window.Close(),
  show: async () => {
    await Window.UnMinimise();
    await Window.Show();
    await Window.Focus();
  },
  isMaximized: () => Window.IsMaximised(),
  onMaximizedChange(fn: (maximized: boolean) => void): () => void {
    const offs = [
      Events.On(Events.Types.Common.WindowMaximise, () => fn(true)),
      Events.On(Events.Types.Common.WindowUnMaximise, () => fn(false)),
      Events.On(Events.Types.Common.WindowRestore, () => { void Window.IsMaximised().then(fn); }),
    ];
    return () => offs.forEach((off) => off());
  },
};

// Node's platform names, which the renderer already uses (window-controls.ts).
function platformName(os: string): string {
  return os === 'windows' ? 'win32' : os;
}

// Links leave the app for the user's browser. Wails can't intercept
// navigation or window.open natively (wails#5799, #5043), so it's done here:
// window.open never makes a second window, and any navigation the page
// starts to another origin (a link, a form, a script assigning location) is
// cancelled — web URLs go to the browser (desktop/links.go), anything else
// is dropped.
function openExternally(url: string): void {
  if (/^https?:\/\//i.test(url)) void Call.ByName('main.LinksService.Open', url).catch(() => {});
}

function guardNavigation(): void {
  window.open = ((url?: string | URL) => {
    if (url !== undefined) openExternally(new URL(String(url), location.href).href);
    return null;
  }) as typeof window.open;
  // A link that opens a new window (target=_blank, a middle click) isn't a
  // navigation of this page, so the Navigation API never sees it.
  const onLinkClick = (ev: MouseEvent): void => {
    if (ev.defaultPrevented || (ev.type === 'click' && ev.button !== 0) || (ev.type === 'auxclick' && ev.button !== 1)) return;
    const a = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const dest = new URL(a.href, location.href);
    if (dest.origin === location.origin) return;
    ev.preventDefault();
    openExternally(dest.href);
  };
  document.addEventListener('click', onLinkClick);
  document.addEventListener('auxclick', onLinkClick);
  const nav = (window as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigate', (ev) => {
    const e = ev as Event & { destination: { url: string }; cancelable: boolean };
    const dest = new URL(e.destination.url);
    if (dest.origin === location.origin) return;
    if (e.cancelable) e.preventDefault();
    openExternally(dest.href);
  });
}

const NOTIFY = 'main.NotifyService';

// The web Notification API over native notifications (desktop/notify.go):
// a webview's own permission only works on Windows. Same shape as the web
// API as far as notifier.ts uses it — permission, requestPermission, a
// constructor taking { body, tag, silent }, onclick, close.
async function installNotifications(): Promise<void> {
  const byId = new Map<string, NativeNotification>();
  let seq = 0;
  class NativeNotification {
    static permission: NotificationPermission = 'default';
    static async requestPermission(): Promise<NotificationPermission> {
      NativeNotification.permission = (await Call.ByName(`${NOTIFY}.RequestPermission`)) as NotificationPermission;
      return NativeNotification.permission;
    }
    onclick: ((this: NativeNotification, ev: Event) => unknown) | null = null;
    private readonly id: string;
    constructor(title: string, opts: NotificationOptions = {}) {
      this.id = opts.tag || `n${++seq}`;
      byId.set(this.id, this);
      void Call.ByName(`${NOTIFY}.Show`, this.id, title, opts.body ?? '', !!opts.silent).catch(() => {});
    }
    close(): void {
      byId.delete(this.id);
      void Call.ByName(`${NOTIFY}.Close`, this.id).catch(() => {});
    }
  }
  NativeNotification.permission = (await Call.ByName(`${NOTIFY}.Permission`)) as NotificationPermission;
  Events.On('notification:click', (ev) => {
    const n = byId.get(ev.data as string);
    n?.onclick?.call(n, new Event('click'));
  });
  (window as unknown as { Notification: unknown }).Notification = NativeNotification;
}

export async function installWailsBridges(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  guardNavigation();
  // A server-mode (e2e) build runs in a browser, which has notifications.
  if (await Call.ByName(`${NOTIFY}.Native`).catch(() => false)) await installNotifications();
  // boson:// links (desktop/deeplink.go): buffered until the renderer drains
  // it on start, and pushed live after that.
  w.bosonDeepLink = {
    consume: async () => ((await Call.ByName('main.DeepLinkService.Consume')) as string) || null,
    onJoin: (fn: (url: string) => void) => Events.On('deep-link:join', (ev) => fn(ev.data as string)),
  };
  // e2e builds only: what the OS would do (desktop/e2e.go).
  if (await Call.ByName('main.E2EService.Enabled').catch(() => false)) {
    w.bosonE2E = {
      secondInstance: (args: string[]) => Call.ByName('main.E2EService.SecondInstance', args),
      openedLinks: () => Call.ByName('main.E2EService.OpenedLinks'),
      setApi: (down: boolean, delayMs: number) => Call.ByName('main.E2EService.SetApi', down, delayMs),
      apiRequests: () => Call.ByName('main.E2EService.ApiRequests'),
    };
  }
  w.bosonPlatform = platformName((await System.Environment()).OS);
  w.bosonWindow = windowBridge;
  w.bosonApi = { fetch: apiFetch };
  // Link previews and Spotify cards, fetched in Go (desktop/unfurl.go,
  // spotify.go) — the page can't fetch other sites (CORS).
  w.bosonUnfurl = { fetch: (url: string) => Call.ByName('main.UnfurlService.Fetch', url) };
  w.bosonSpotify = { fetch: (url: string) => Call.ByName('main.SpotifyService.Fetch', url) };
  // Theme files in <data dir>/themes (desktop/themes.go).
  w.bosonThemes = {
    list: () => Call.ByName(`${THEMES}.List`),
    write: (id: string, text: string) => Call.ByName(`${THEMES}.Write`, id, text),
    remove: (id: string) => Call.ByName(`${THEMES}.Remove`, id),
    openFolder: () => Call.ByName(`${THEMES}.OpenFolder`),
    onChange: (fn: () => void) => Events.On('themes:changed', () => fn()),
  };
  // Where the YouTube wrapper is served (desktop/youtube.go): YouTube won't
  // play inside a wails:// page. Read once — Embed.tsx needs it synchronously.
  w.bosonYouTube = { wrapperOrigin: ((await Call.ByName('main.YouTubeService.WrapperOrigin').catch(() => '')) as string) || null };
  // Update checks (desktop/updater.go).
  w.bosonUpdater = {
    getState: () => Call.ByName(`${UPDATER}.GetState`),
    checkNow: () => Call.ByName(`${UPDATER}.CheckNow`),
    applyDownloadedUpdate: () => Call.ByName(`${UPDATER}.ApplyDownloadedUpdate`),
    onState: (fn: (s: unknown) => void) => Events.On('updater:state', (ev) => fn(ev.data)),
  };
  // Secrets: desktop/securestore.go (keychain-held key, same file format).
  w.bosonSecure = {
    isAvailable: () => Call.ByName(`${STORE}.IsAvailable`) as Promise<boolean>,
    get: (key: string) => Call.ByName(`${STORE}.Get`, key) as Promise<string | null>,
    set: (key: string, value: string) => Call.ByName(`${STORE}.Set`, key, value) as Promise<void>,
    remove: (key: string) => Call.ByName(`${STORE}.Remove`, key) as Promise<void>,
  };
  w.bosonEngine = {
    discovery: async () => ({ url: 'wails:engine', token: 'in-process', socket: WailsEngineSocket }),
  };
  // Last: everything above is in place (e2e launches wait for this).
  w.bosonShellReady = true;
}
