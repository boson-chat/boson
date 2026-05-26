import { contextBridge, ipcRenderer } from 'electron';

// Bridge between the sandboxed renderer and the main-process SecureStore.
// Mirrors the IPC channel names used in `src/main/index.ts`. Every call goes
// through `ipcRenderer.invoke` so we get a Promise on both sides and any
// validation error in main surfaces as a rejection in the renderer.
//
// Renderer-side type declaration lives in
// `src/renderer/src/shared/secure-storage.ts` so the renderer can reference
// `window.bosonSecure` with full TypeScript types.
const bosonSecure = {
  async isAvailable(): Promise<boolean> {
    return ipcRenderer.invoke('secureStore:isAvailable');
  },
  async get(key: string): Promise<string | null> {
    return ipcRenderer.invoke('secureStore:get', key);
  },
  async set(key: string, value: string): Promise<void> {
    return ipcRenderer.invoke('secureStore:set', key, value);
  },
  async remove(key: string): Promise<void> {
    return ipcRenderer.invoke('secureStore:remove', key);
  },
};

contextBridge.exposeInMainWorld('bosonSecure', bosonSecure);

// Custom title-bar controls. The renderer renders its own window chrome
// (minimize / maximize / close) because main creates a frameless (or macOS
// `hiddenInset`) BrowserWindow. `onMaximizedChange` lets the renderer flip
// the maximize-button icon between max + restore as the user double-clicks
// the title bar, drags from the top, or hits Win+↑.
const bosonWindow = {
  minimize(): Promise<void> { return ipcRenderer.invoke('window:minimize'); },
  toggleMaximize(): Promise<void> { return ipcRenderer.invoke('window:toggle-maximize'); },
  close(): Promise<void> { return ipcRenderer.invoke('window:close'); },
  isMaximized(): Promise<boolean> { return ipcRenderer.invoke('window:is-maximized'); },
  onMaximizedChange(fn: (maximized: boolean) => void): () => void {
    const listener = (_evt: unknown, maximized: boolean): void => fn(maximized);
    ipcRenderer.on('window:maximized-change', listener);
    return () => { ipcRenderer.off('window:maximized-change', listener); };
  },
};

contextBridge.exposeInMainWorld('bosonWindow', bosonWindow);
// Expose the host platform so the renderer knows whether to draw its own
// min/max/close controls (Windows + Linux) or stay out of the way of the
// native traffic lights (macOS).
contextBridge.exposeInMainWorld('bosonPlatform', process.platform);

export type BosonSecure = typeof bosonSecure;
export type BosonWindow = typeof bosonWindow;
