// Renderer-side typings + thin wrapper around the `bosonWindow` bridge that
// preload exposes. Keeping the bridge interface here (instead of importing
// from preload) avoids pulling `electron` into the renderer bundle.
//
// The bridge is OPTIONAL at runtime — happy-dom tests and vitest don't have
// preload, so window-controls calls just no-op there.

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

/** Get the bridge, or null in tests / non-Electron contexts. */
export function getWindowBridge(): BosonWindowBridge | null {
  return (typeof window !== 'undefined' && window.bosonWindow) || null;
}
