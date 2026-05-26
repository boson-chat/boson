import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { SecureStore } from './secure-store';

class BosonApp {
  private mainWindow: BrowserWindow | null = null;
  // Constructed lazily after `app.whenReady()` — `app.getPath('userData')`
  // is only valid after that point.
  private secureStore: SecureStore | null = null;

  async start(): Promise<void> {
    await app.whenReady();
    this.secureStore = new SecureStore();
    // Surface the chosen encryption mode at startup so devs can see why their
    // identity isn't persisting (typical cause: WSL2 / headless Linux without
    // a keyring daemon → falls back to derived-key AES-GCM).
    console.log(`[secure-store] mode=${this.secureStore.mode()}`);
    this.registerIpc(this.secureStore);
    this.createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) this.createWindow();
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });
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

    this.mainWindow.on('ready-to-show', () => this.mainWindow?.show());

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
