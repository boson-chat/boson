import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { SecureStore } from './secure-store';
import { engine } from './engine';

// boson:// is the custom URL scheme that the marketing site's directory
// page (/discover) deep-links to. Format: boson://join?host=…&port=…&tls=1
// — see handleDeepLink() below for the parser. Registered with the OS
// via setAsDefaultProtocolClient + electron-builder's `protocols` block.
const DEEP_LINK_SCHEME = 'boson';

interface PendingDeepLink {
  url: string;
}

class BosonApp {
  private mainWindow: BrowserWindow | null = null;
  // Constructed lazily after `app.whenReady()` — `app.getPath('userData')`
  // is only valid after that point.
  private secureStore: SecureStore | null = null;
  // Deep-link URL captured before the renderer was ready (cold-start
  // from a boson:// click on Windows/Linux, or an open-url event on
  // macOS before our window exists). Drained on ready-to-show.
  private pendingDeepLink: PendingDeepLink | null = null;

  async start(): Promise<void> {
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

    // Engine discovery — renderer asks once at boot to learn the
    // loopback URL + token for the bundled IRC bridge. Returns null in
    // dev (no sidecar binary on disk); renderer falls back to
    // VITE_ENGINE_URL / VITE_ENGINE_TOKEN in that case.
    ipcMain.handle('engine:discovery', () => engine.current());

    // Deep-link drain. Renderer calls this once on boot to pick up any
    // boson:// URL the OS handed us before the window existed (cold
    // start from a browser click on Windows/Linux). After that, fresh
    // deep-links arrive via the 'deep-link:join' webContents.send below.
    ipcMain.handle('deepLink:consume', () => {
      const pending = this.pendingDeepLink;
      this.pendingDeepLink = null;
      return pending?.url ?? null;
    });
  }

  // Forward a deep-link URL to the renderer if it's ready, else buffer
  // it. The renderer parses + dispatches — keeping URL semantics there
  // means the schema can evolve without touching the main process.
  private dispatchDeepLink(url: string): void {
    if (!url.startsWith(`${DEEP_LINK_SCHEME}://`)) return;
    if (this.mainWindow && !this.mainWindow.webContents.isLoading()) {
      this.mainWindow.webContents.send('deep-link:join', url);
    } else {
      this.pendingDeepLink = { url };
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
      // If we captured a deep link before the window opened, hand it
      // off now. The renderer will also call deepLink:consume on boot
      // as a backup for the timing case where it loads faster than this
      // event fires.
      if (this.pendingDeepLink) {
        const { url } = this.pendingDeepLink;
        this.pendingDeepLink = null;
        this.mainWindow?.webContents.send('deep-link:join', url);
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
      shell.openExternal(url);
      return { action: 'deny' };
    });

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) {
      this.mainWindow.loadURL(devUrl);
      this.mainWindow.webContents.openDevTools({ mode: 'right' });
    } else {
      this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }
  }
}

new BosonApp().start();
