// Renderer-side accessor for the main-process Spotify metadata bridge (preload
// exposes `window.bosonSpotify`). Returns the fetcher inside Electron, or
// undefined on the web build / in tests (callers then show a minimal card).

export interface SpotifyTrack {
  title: string;
  artist: string;
  durationMs: number;
  previewUrl?: string;
}

export interface SpotifyInfo {
  url: string;
  type: string;
  title: string;
  subtitle?: string;
  cover?: string;
  durationMs?: number;
  previewUrl?: string;
  tracks?: SpotifyTrack[];
}

export interface BosonSpotifyBridge {
  fetch(url: string): Promise<SpotifyInfo | null>;
}

declare global {
  interface Window {
    bosonSpotify?: BosonSpotifyBridge;
  }
}

export function getSpotify(): ((url: string) => Promise<SpotifyInfo | null>) | undefined {
  const bridge = typeof window !== 'undefined' ? window.bosonSpotify : undefined;
  return bridge ? (url) => bridge.fetch(url) : undefined;
}
