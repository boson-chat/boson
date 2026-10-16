// Renderer-side typings + thin wrapper around the `bosonWindow` bridge that
// platform/wails.ts installs (Wails Window API). Keeping the bridge interface
// here (instead of importing the shell) keeps the Wails runtime out of the
// browser bundle.
//
// The bridge is OPTIONAL at runtime — happy-dom tests and vitest don't have
// it, so window-controls calls just no-op there.

export type BosonPlatform = 'darwin' | 'win32' | 'linux' | string;

export interface BosonWindowBridge {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  show?(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(fn: (maximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    bosonWindow?: BosonWindowBridge;
    bosonPlatform?: BosonPlatform;
  }
}

/** Returns the host platform, or `'linux'` as a benign default in tests. */
export function getPlatform(): BosonPlatform {
  return (typeof window !== 'undefined' && window.bosonPlatform) || 'linux';
}

/** True on macOS — used to suppress the custom min/max/close buttons. */
export function isDarwin(): boolean {
  return getPlatform() === 'darwin';
}

/** iOS or Android: the window is the screen — no window controls. */
export function isMobile(): boolean {
  const p = getPlatform();
  return p === 'ios' || p === 'android';
}

/** Get the bridge, or null in tests / browser contexts. */
export function getWindowBridge(): BosonWindowBridge | null {
  return (typeof window !== 'undefined' && window.bosonWindow) || null;
}
