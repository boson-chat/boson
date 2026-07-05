import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { createServer, type Server } from 'node:http';
import { createReadStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { SecureStore } from './secure-store';
import { engine } from './engine';
import { applyDownloadedUpdate, checkNow, getUpdateState, startAutoUpdater } from './auto-update';
import { unfurl } from './unfurl';
import { fetchSpotifyInfo } from './spotify';
import { proxyApiFetch } from './api-proxy';

// boson:// is the custom URL scheme that the marketing site's directory
// page (/discover) deep-links to. Format: boson://join?host=…&port=…&tls=1
// — see handleDeepLink() below for the parser. Registered with the OS
// via setAsDefaultProtocolClient + electron-builder's `protocols` block.
const DEEP_LINK_SCHEME = 'boson';

// Extension→MIME map for the loopback static server (see startRendererServer).
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.wasm': 'application/wasm',
};

interface PendingDeepLink {
  url: string;
}

class BosonApp {
  private mainWindow: BrowserWindow | null = null;
  // Base URL of the loopback renderer server in production (http://127.0.0.1:<port>).
  private rendererBase = '';
  // Constructed lazily after `app.whenReady()` — `app.getPath('userData')`
  // is only valid after that point.
  private secureStore: SecureStore | null = null;
  // Deep-link URL captured before the renderer was ready (cold-start
  // from a boson:// click on Windows/Linux, or an open-url event on
  // macOS before our window exists). Drained on ready-to-show.
  private pendingDeepLink: PendingDeepLink | null = null;

  async start(): Promise<void> {
    // Guarantee a structurally valid locale before Chromium initializes. On some
    // Linux/WSL setups the system locale is empty or "C", which leaves
    // navigator.languages with an invalid entry — and any embedded content that
    // does `new Intl.Locale(navigator.languages[i])` (e.g. Spotify's embed)
    // throws "RangeError: Incorrect locale information provided". Forcing a sane
    // default keeps locale-sensitive code (ours and third-party) from crashing.
    app.commandLine.appendSwitch('lang', 'en-US');
    // Windows needs the AppUserModelID to match the installed app for native
    // notifications to render with the right identity (and not silently drop).
    if (process.platform === 'win32') app.setAppUserModelId('chat.boson.app');
    if (process.platform === 'linux' && !/[a-z]{2}[-_][A-Z]{2}/.test(process.env['LANG'] ?? '')) {
      process.env['LANG'] = 'en_US.UTF-8';
    }


    // Single-instance lock: when a second invocation tries to start
    // (typical path: user clicks boson:// in a browser while the app is
    // already running on Windows/Linux), the OS hands its argv to us
    // here via second-instance, then exits the duplicate. Without this,
    // clicking a deep link launches a fresh app instance that doesn't
    // know about the running one.
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return;
    }
    app.on('second-instance', (_event, argv) => {
      const url = argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
      if (url) this.dispatchDeepLink(url);
      // Bring the existing window forward so the user sees the result
      // of the deep link rather than the browser they came from.
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
      }
    });

    // macOS: deep links arrive via open-url. May fire before whenReady,
    // so we register the listener up-front and buffer until the window
    // exists.
    app.on('open-url', (event, url) => {
      event.preventDefault();
      this.dispatchDeepLink(url);
    });

    // Register the URL scheme with the OS. On macOS this is mostly a
    // formality (electron-builder writes CFBundleURLTypes into Info.plist
    // and the OS reads that). On Windows + Linux we need to register at
    // runtime so the .exe / .desktop entry handles boson:// URLs.
    if (process.defaultApp) {
      // Dev mode: passing the entrypoint script as the second arg so
      // OS-handed-back deep links re-run electron with the right
      // working tree. Doesn't matter for prod builds.
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
          require('node:path').resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    }

    // Windows + Linux cold-start: the deep link is in argv[1+]. Capture
    // it before we even reach whenReady so the renderer picks it up on
    // first paint instead of needing a separate trigger.
    const argvDeepLink = process.argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (argvDeepLink) this.pendingDeepLink = { url: argvDeepLink };

    await app.whenReady();
    // Production: serve the renderer over loopback http so it has a real origin
    // (embeds need it; API calls go through the main-process proxy to dodge
    // CORS). Dev uses the Vite server.
    if (!process.env['ELECTRON_RENDERER_URL']) {
      this.rendererBase = await startRendererServer().catch((err) => {
        console.error('[renderer-server] failed to start', err);
        return '';
      });
      // Carry the old file:// localStorage (locally-added servers, session,
      // memos, settings) over to the new loopback origin — once.
      if (this.rendererBase) await migrateFileStorage(this.rendererBase);
    }
    this.secureStore = new SecureStore();
    // Surface the chosen encryption mode at startup so devs can see why their
    // identity isn't persisting (typical cause: WSL2 / headless Linux without
    // a keyring daemon → falls back to derived-key AES-GCM).
    console.log(`[secure-store] mode=${this.secureStore.mode()}`);
    // Spawn the bundled engine sidecar BEFORE the renderer loads so the
    // IPC discovery handler has its URL/token ready by the time the
    // renderer asks. Returns null in dev mode (no bundled binary) — the
    // renderer's existing VITE_ENGINE_URL fallback handles that path.
    await engine.start().catch((err) => console.error('[engine] start failed', err));
    this.registerIpc(this.secureStore);
    this.createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) this.createWindow();
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });
    // Kill the engine child cleanly when the app is asked to quit so we
    // don't leak a Go process. `before-quit` fires for every shutdown
    // path (window close on Win/Linux, Cmd+Q on macOS, SIGTERM).
    app.on('before-quit', () => engine.stop());
  }

  // IPC: every renderer-facing handler validates its inputs. Keys must be
  // non-empty strings; values must be strings. Anything else is rejected with
  // a typed error so a broken renderer can't silently desync the store.
  private registerIpc(store: SecureStore): void {
    ipcMain.handle('secureStore:isAvailable', () => store.isAvailable());
    ipcMain.handle('secureStore:get', async (_evt, key: unknown) => {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('secureStore:get requires a non-empty string key');
      }
      return store.get(key);
    });
    ipcMain.handle('secureStore:set', async (_evt, key: unknown, value: unknown) => {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('secureStore:set requires a non-empty string key');
      }
      if (typeof value !== 'string') {
        throw new Error('secureStore:set requires a string value');
      }
      await store.set(key, value);
    });
    ipcMain.handle('secureStore:remove', async (_evt, key: unknown) => {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('secureStore:remove requires a non-empty string key');
      }
      await store.remove(key);
    });

    // Custom title-bar controls. The renderer's TitleBar component calls
    // these instead of the OS chrome we suppressed in createWindow().
    ipcMain.handle('window:minimize', () => { this.mainWindow?.minimize(); });
    ipcMain.handle('window:toggle-maximize', () => {
      if (!this.mainWindow) return;
      if (this.mainWindow.isMaximized()) this.mainWindow.unmaximize();
      else this.mainWindow.maximize();
    });
    ipcMain.handle('window:close', () => { this.mainWindow?.close(); });
    ipcMain.handle('window:is-maximized', () => this.mainWindow?.isMaximized() ?? false);
    // Restore + focus the window (notification click).
    ipcMain.handle('window:show', () => {
      const w = this.mainWindow;
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    });

    // Engine discovery — renderer asks once at boot to learn the
    // loopback URL + token for the bundled IRC bridge. Returns null in
    // dev (no sidecar binary on disk); renderer falls back to
    // VITE_ENGINE_URL / VITE_ENGINE_TOKEN in that case.
    ipcMain.handle('engine:discovery', () => engine.current());

    // Link-unfurl: fetch + parse OG/title metadata for a website preview card.
    // Renderer-driven (click-to-load) only; main can fetch arbitrary hosts
    // without CORS. Loopback/private hosts are rejected inside unfurl().
    ipcMain.handle('unfurl:fetch', (_e, url: unknown) =>
      typeof url === 'string' ? unfurl(url) : Promise.resolve(null),
    );

    // Spotify: parse the embed page's __NEXT_DATA__ for title/cover and (for
    // playlists/albums) the full track list + 30s preview URLs, so the renderer
    // shows a native card/list instead of Spotify's crash-prone iframe.
    ipcMain.handle('spotify:fetch', (_e, url: unknown) =>
      typeof url === 'string' ? fetchSpotifyInfo(url) : Promise.resolve(null),
    );

    // API proxy: the renderer runs on a loopback http origin (for embeds), so
    // its api.boson.chat calls would be CORS-blocked. Perform them here in main
    // (Node fetch, no CORS) and hand back status + body text.
    ipcMain.handle('api:fetch', (_e, req: unknown) =>
      proxyApiFetch(req as Parameters<typeof proxyApiFetch>[0]),
    );

    // Deep-link drain. Renderer calls this once on boot to pick up any
    // boson:// URL the OS handed us before the window existed (cold
    // start from a browser click on Windows/Linux). After that, fresh
    // deep-links arrive via the 'deep-link:join' webContents.send below.
    ipcMain.handle('deepLink:consume', () => {
      const pending = this.pendingDeepLink;
      this.pendingDeepLink = null;
      return pending?.url ?? null;
    });

    // Auto-update: renderer reads + drives the updater via these three
    // channels. `getState` gives the current snapshot at boot so the
    // banner can render immediately without waiting for the next
    // `updater:state` push. `checkNow` lets the About panel's manual
    // "Check for updates" button short-circuit the 6h cadence.
    // `apply` triggers quitAndInstall once the user clicks "Restart".
    ipcMain.handle('updater:getState', () => getUpdateState());
    ipcMain.handle('updater:checkNow', () => checkNow());
    ipcMain.handle('updater:apply', () => { applyDownloadedUpdate(); });
  }

  // Forward a deep-link URL to the renderer. Always buffer AND
  // best-effort send live — the buffer is the source of truth and the
  // renderer's `deepLink:consume` IPC drains it once the listener is
  // wired up. The live send is an optimisation for the warm-start case
  // where the listener is already attached.
  //
  // The "always buffer" half is what makes cold-start reliable: when
  // the OS launches the app to handle a boson:// URL, the renderer's
  // `ipcRenderer.on('deep-link:join', ...)` listener typically isn't
  // attached yet when `ready-to-show` fires, so the live send goes
  // nowhere. With the buffer in place, consume() picks it up as soon
  // as initDeepLinkBridge() runs. Renderer-side dedupe (deliver() in
  // deep-link.ts) handles the case where both paths fire for the same
  // URL.
  private dispatchDeepLink(url: string): void {
    if (!url.startsWith(`${DEEP_LINK_SCHEME}://`)) return;
    this.pendingDeepLink = { url };
    if (this.mainWindow && !this.mainWindow.webContents.isLoading()) {
      this.mainWindow.webContents.send('deep-link:join', url);
    }
  }

  private createWindow(): void {
    this.mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#1a1b1e',
      // Custom title bar — frameless on Windows/Linux, `hiddenInset` on
      // macOS so the native traffic-light controls stay visible (Mac users
      // expect them) but the OS chrome above is gone.
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 12 } }
        : { frame: false }),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.mainWindow.on('ready-to-show', () => {
      this.mainWindow?.show();
      // Kick off the auto-update lifecycle now that we have a window
      // to send state to. No-op in dev mode (`app.isPackaged === false`).
      if (this.mainWindow) startAutoUpdater(this.mainWindow);
      // If we captured a deep link before the window opened, fire it
      // live as a best-effort. The buffer stays populated so the
      // renderer's `deepLink:consume` IPC can drain it once
      // `initDeepLinkBridge()` runs — that's the canonical path, since
      // `ready-to-show` fires while the renderer is still mid-bootstrap
      // and the `ipcRenderer.on('deep-link:join')` listener typically
      // isn't attached yet. Renderer-side dedupe handles the case where
      // both paths deliver the same URL.
      if (this.pendingDeepLink) {
        this.mainWindow?.webContents.send('deep-link:join', this.pendingDeepLink.url);
      }
    });

    // Broadcast maximize / unmaximize transitions so the renderer can swap
    // the maximize button between max and restore icons in real time.
    const broadcastMaxState = (): void => {
      if (!this.mainWindow) return;
      this.mainWindow.webContents.send('window:maximized-change', this.mainWindow.isMaximized());
    };
    this.mainWindow.on('maximize', broadcastMaxState);
    this.mainWindow.on('unmaximize', broadcastMaxState);

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // Only hand http/https to the OS. Without this guard any renderer
      // path (or an XSS foothold) that reaches window.open could launch
      // arbitrary schemes — file://, smb://, or app/installer handlers.
      let scheme = '';
      try {
        scheme = new URL(url).protocol;
      } catch {
        return { action: 'deny' };
      }
      if (scheme === 'http:' || scheme === 'https:') {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) {
      this.mainWindow.loadURL(devUrl);
      this.mainWindow.webContents.openDevTools({ mode: 'right' });
    } else if (this.rendererBase) {
      // Loopback http origin so origin/referrer-sensitive embeds work.
      this.mainWindow.loadURL(`${this.rendererBase}/index.html`);
    } else {
      // Fallback if the loopback server didn't start (API still works; embeds
      // fall back to opening externally on the file:// origin).
      this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
  }
}

// The renderer's origin is http://127.0.0.1:<port>, and localStorage (Supabase
// session, UI prefs) is keyed by origin — so the port must stay STABLE across
// launches or the user is logged out every time. We persist the chosen port and
// reuse it; if it's taken (rare — single-instance lock means no second Boson, so
// only a foreign app could grab it), we fall back to a fresh free port (storage
// resets that once). First launch just picks any free port.
function portFile(): string {
  return join(app.getPath('userData'), 'renderer-port');
}
function readSavedPort(): number {
  try {
    const n = parseInt(readFileSync(portFile(), 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 1024 && n < 65536 ? n : 0;
  } catch { return 0; }
}
function savePort(p: number): void {
  try { writeFileSync(portFile(), String(p)); } catch { /* best-effort */ }
}

// One-time migration of localStorage from the legacy file:// origin (used by
// builds that loaded the renderer via loadFile) to the new loopback http origin.
// Without this, upgrading users would silently lose their session, locally-added
// servers, memos, and settings (localStorage is keyed by origin). Reads the old
// data in a hidden file:// window, then writes it into the new origin via the
// blank /__migrate page. Guarded by a flag file so it runs only once.
async function migrateFileStorage(rendererBase: string): Promise<void> {
  const flag = join(app.getPath('userData'), 'storage-migrated-v1');
  if (existsSync(flag)) return;
  try {
    // 1. Read the legacy file:// localStorage via a blank file:// page (all
    //    file:// pages share one localStorage bucket, so this sees the old data
    //    without booting the app).
    const probe = join(app.getPath('userData'), '_storage_probe.html');
    writeFileSync(probe, '<!doctype html><meta charset="utf-8"><title>probe</title>');
    const reader = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    let data: Record<string, string> = {};
    try {
      await reader.loadFile(probe);
      const json = await reader.webContents.executeJavaScript('JSON.stringify(window.localStorage)');
      data = JSON.parse(json) as Record<string, string>;
    } finally {
      reader.destroy();
    }

    // 2. Write it into the new origin (skip keys already set there).
    const keys = Object.keys(data);
    if (keys.length > 0) {
      const writer = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      try {
        await writer.loadURL(`${rendererBase}/__migrate`);
        // Runs in the renderer (http origin): copy each key, never overwriting.
        const script = `(function(d){for(var k in d){`
          + `if(localStorage.getItem(k)===null)localStorage.setItem(k,d[k]);}})(${JSON.stringify(data)})`;
        await writer.webContents.executeJavaScript(script);
      } finally {
        writer.destroy();
      }
      console.log(`[migrate] copied ${keys.length} localStorage key(s) from file:// to ${rendererBase}`);
    }
  } catch (err) {
    console.error('[migrate] file:// storage migration failed', err);
  }
  // Best-effort: mark done regardless so we don't retry (and re-run hidden
  // windows) on every launch.
  try { writeFileSync(flag, '1'); } catch { /* ignore */ }
}

// Serve the built renderer (out/renderer) from a 127.0.0.1-only HTTP server so
// the page has a real http origin. Returns the base URL (http://127.0.0.1:<port>).
// MIME-typed, path-traversal guarded, with an index.html fallback for routes.
function startRendererServer(): Promise<string> {
  const rendererDir = join(__dirname, '../renderer');
  return new Promise<string>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      void (async () => {
        try {
          let rel = decodeURIComponent((req.url ?? '/').split('?')[0]!);
          // Blank page used only by the one-time file:// → http storage
          // migration to write localStorage on the new origin (no app boot).
          if (rel === '/__migrate') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><meta charset="utf-8"><title>migrate</title>');
            return;
          }
          if (rel === '/' || rel === '') rel = '/index.html';
          let filePath = normalize(join(rendererDir, rel));
          if (filePath !== rendererDir && !filePath.startsWith(rendererDir + sep)) {
            res.writeHead(403).end('Forbidden');
            return;
          }
          try {
            const s = await stat(filePath);
            if (s.isDirectory()) filePath = join(filePath, 'index.html');
          } catch {
            filePath = join(rendererDir, 'index.html'); // SPA fallback
          }
          res.writeHead(200, { 'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
          createReadStream(filePath).on('error', () => res.end()).pipe(res);
        } catch {
          res.writeHead(500).end('error');
        }
      })();
    });

    const listenOn = (port: number, retried: boolean): void => {
      server.removeAllListeners('error');
      server.once('error', (err: NodeJS.ErrnoException) => {
        // Saved port taken → grab any free port (port 0). Only retry once.
        if (err.code === 'EADDRINUSE' && !retried) listenOn(0, true);
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        const actual = addr && typeof addr === 'object' ? addr.port : port;
        savePort(actual);
        resolve(`http://127.0.0.1:${actual}`);
      });
    };
    listenOn(readSavedPort(), false);
  });
}

new BosonApp().start();
