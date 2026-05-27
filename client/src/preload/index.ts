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

// Engine sidecar discovery. The main process spawns the bundled Go IRC
// bridge on a random loopback port at app start; the renderer asks for
// the URL + token via this channel. Resolves to null in dev mode where
// the engine isn't bundled (renderer then falls back to VITE_ENGINE_URL).
interface BosonEngineDiscovery {
  url: string;
  token: string;
}
const bosonEngine = {
  async discovery(): Promise<BosonEngineDiscovery | null> {
    return ipcRenderer.invoke('engine:discovery');
  },
};
contextBridge.exposeInMainWorld('bosonEngine', bosonEngine);

// Deep-link bridge. The marketing site's /discover page renders Join
// buttons as `boson://join?host=…&port=…&tls=1` links; clicking one
// hands the URL to the installed app via the OS. The main process
// either buffers it (cold start) or pushes it live; both paths fan
// through the same `deep-link:join` channel here.
//
// `consume` is a one-shot drain for the cold-start case — the
// renderer calls it on boot to pick up any URL that arrived before
// the IPC listener was attached. After that, `onJoin` receives every
// fresh deep-link as it lands.
const bosonDeepLink = {
  async consume(): Promise<string | null> {
    return ipcRenderer.invoke('deepLink:consume');
  },
  onJoin(fn: (url: string) => void): () => void {
    const listener = (_evt: unknown, url: string): void => fn(url);
    ipcRenderer.on('deep-link:join', listener);
    return () => { ipcRenderer.off('deep-link:join', listener); };
  },
};
contextBridge.exposeInMainWorld('bosonDeepLink', bosonDeepLink);

export type BosonSecure = typeof bosonSecure;
export type BosonWindow = typeof bosonWindow;
export type BosonEngine = typeof bosonEngine;
export type BosonDeepLink = typeof bosonDeepLink;
