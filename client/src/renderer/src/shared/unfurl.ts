// Renderer-side accessor for the shell's link-unfurl bridge (desktop/unfurl.go
// via `window.bosonUnfurl`; on the web, platform/web/unfurl.ts through the
// boson API). Returns the fetcher, or undefined without a shell (tests,
// `npm run dev`) — callers then fall back to just opening the link
// externally instead of showing a preview card.

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
  // Web only (platform/web/unfurl.ts): the signed-in user's access token.
  setTokenSource?(fn: (() => Promise<string | null>) | null): void;
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
