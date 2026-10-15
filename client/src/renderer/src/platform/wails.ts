// The Wails desktop shell. Loaded (dynamically, from main.tsx) only when the
// page is served by Wails, so the Electron and browser builds never pull in
// the Wails runtime. It installs the same window.boson* bridges the Electron
// preload exposes, backed by Go services in desktop/.

import { Call, Events, System, Window } from '@wailsio/runtime';
import type { WebSocketLike } from '../modules/engine/engine.client';
import type { ApiRequest, ApiResponse } from '../shared/http/transport';

const ENGINE = 'main.EngineService';
const STORE = 'main.SecureStore';

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

export async function installWailsBridges(): Promise<void> {
  const w = window as unknown as Record<string, unknown>;
  w.bosonPlatform = platformName((await System.Environment()).OS);
  w.bosonWindow = windowBridge;
  w.bosonApi = { fetch: apiFetch };
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
}
