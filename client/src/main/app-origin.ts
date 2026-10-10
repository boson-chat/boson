// "Is this URL our own app?" — the single trust decision behind the main
// window's navigation guard, the IPC sender check, and the permission
// handlers in index.ts. Kept free of `electron` imports so it's unit-testable.
//
// The renderer is loaded from exactly one of three places:
//   - packaged: the loopback static server, http://127.0.0.1:<port>
//   - dev:      the electron-vite dev server (ELECTRON_RENDERER_URL)
//   - fallback: file://…/out/renderer/index.html, if the loopback server
//               failed to start
// Anything else — a page reached by dragging a link onto the window, a
// redirect, an iframe — must not be treated as the app: the preload bridges
// it would inherit expose secrets (bosonSecure), the engine token and the
// API proxy.
import { pathToFileURL } from 'node:url';

export interface AppOriginConfig {
  // http(s) bases the renderer is served from (loopback server, dev server).
  // Only their origin (scheme + host + port) is compared.
  httpBases: string[];
  // Absolute path to the built renderer directory when it was loaded via
  // file:// (the fallback). null when the renderer is served over http.
  // file:// URLs all share the opaque "null" origin, so for this case we
  // match on path prefix instead — otherwise ANY local file a user drags
  // onto the window would count as "the app".
  fileRoot: string | null;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export class AppOrigin {
  private readonly origins: Set<string>;
  private readonly filePrefix: string | null;

  constructor(cfg: AppOriginConfig) {
    this.origins = new Set(
      cfg.httpBases.map(originOf).filter((o): o is string => o !== null),
    );
    // Trailing slash so /out/renderer-evil/… can't prefix-match /out/renderer.
    this.filePrefix = cfg.fileRoot
      ? pathToFileURL(cfg.fileRoot).href.replace(/\/?$/, '/')
      : null;
  }

  // True when `url` is a document belonging to the app itself.
  isAppUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol === 'file:') {
      // Compare the normalised href (WHATWG URL resolves ../ segments) so a
      // traversal like file:///…/renderer/../../etc can't sneak through.
      return this.filePrefix !== null && u.href.startsWith(this.filePrefix);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return this.origins.has(u.origin);
  }

  // Permission handlers hand us a bare origin string ("http://127.0.0.1:1234",
  // or "file://" for file: documents) rather than a full URL.
  isAppOrigin(origin: string | null | undefined): boolean {
    if (!origin) return false;
    if (origin === 'file://' || origin === 'null') return this.filePrefix !== null;
    return this.origins.has(origin.replace(/\/$/, ''));
  }
}
