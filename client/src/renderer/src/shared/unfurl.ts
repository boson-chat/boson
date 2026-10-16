// Renderer-side accessor for the shell's link-unfurl bridge (desktop/unfurl.go
// via `window.bosonUnfurl`). Returns the fetcher when running inside the
// desktop app, or undefined (web build / tests) — callers then fall back to just
// opening the link externally instead of showing a preview card.

export interface OgCard {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  author?: string;
  date?: string;
}

export interface BosonUnfurlBridge {
  fetch(url: string): Promise<OgCard | null>;
}

declare global {
  interface Window {
    bosonUnfurl?: BosonUnfurlBridge;
  }
}

// The unfurl fetcher, or undefined when the bridge isn't present.
export function getUnfurl(): ((url: string) => Promise<OgCard | null>) | undefined {
  const bridge = typeof window !== 'undefined' ? window.bosonUnfurl : undefined;
  return bridge ? (url) => bridge.fetch(url) : undefined;
}
