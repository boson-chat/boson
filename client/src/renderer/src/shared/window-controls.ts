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
  // The native window's own focus / visibility, from the shell's window
  // events (desktop app with a real window only), so the notifier doesn't
  // depend on the webview's DOM focus/blur alone.
  attention?(): Promise<WindowAttention>;
  onAttentionChange?(fn: () => void): () => void;
}

// Whether the user can be looking at the app: `focused` = the window has
// keyboard focus; `visible` = it's on screen (not minimised or hidden), even
// if another app has focus.
export interface WindowAttention {
  focused: boolean;
  visible: boolean;
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

/**
 * Whether the title bar steps aside in the phone layout: only where it holds
 * no window controls or drag region (the iOS / Android app, the web build).
 * A narrow desktop window keeps it. With it gone, each phone screen's own
 * header clears the status bar, the bell is in the server rail under your
 * avatar and settings are in My space.
 */
export function titleBarYields(): boolean {
  return isMobile() || (window as { bosonShell?: string }).bosonShell === 'web';
}

/** Get the bridge, or null in tests / browser contexts. */
export function getWindowBridge(): BosonWindowBridge | null {
  return (typeof window !== 'undefined' && window.bosonWindow) || null;
}
