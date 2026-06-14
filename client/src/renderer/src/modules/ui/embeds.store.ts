// Global, local-only preferences for rich link embeds. Embeds are on and
// AUTO-LOAD by default (media/previews appear without a click). Privacy-minded
// users can switch to click-to-load, which keeps everything inert (no remote
// content or IP leak) until clicked. Persisted to localStorage; changes
// broadcast via a same-tab CustomEvent so the message view + settings UI react.

const STORAGE_KEY = 'boson:embeds:v1';

export interface EmbedSettings {
  // Master switch — off hides all embeds (links stay as plain text).
  enabled: boolean;
  // 'click' = inert chip until the user clicks; 'auto' = load on arrival.
  loadMode: 'click' | 'auto';
  // Per-type opt-outs.
  images: boolean;
  videos: boolean;
  youtube: boolean;
  spotify: boolean;
  websites: boolean;
}

export const DEFAULT_EMBED_SETTINGS: EmbedSettings = {
  enabled: true,
  loadMode: 'auto',
  images: true,
  videos: true,
  youtube: true,
  spotify: true,
  websites: true,
};

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined') return null;
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

let cached: EmbedSettings | null = null;

export function getEmbedSettings(): EmbedSettings {
  if (cached) return cached;
  const s = getStorage();
  let next = { ...DEFAULT_EMBED_SETTINGS };
  if (s) {
    try {
      const raw = s.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<EmbedSettings>;
        next = {
          enabled: typeof p.enabled === 'boolean' ? p.enabled : next.enabled,
          loadMode: p.loadMode === 'auto' || p.loadMode === 'click' ? p.loadMode : next.loadMode,
          images: typeof p.images === 'boolean' ? p.images : next.images,
          videos: typeof p.videos === 'boolean' ? p.videos : next.videos,
          youtube: typeof p.youtube === 'boolean' ? p.youtube : next.youtube,
          spotify: typeof p.spotify === 'boolean' ? p.spotify : next.spotify,
          websites: typeof p.websites === 'boolean' ? p.websites : next.websites,
        };
      }
    } catch { /* keep defaults */ }
  }
  cached = next;
  return next;
}

export function setEmbedSettings(patch: Partial<EmbedSettings>): void {
  const next = { ...getEmbedSettings(), ...patch };
  cached = next;
  const s = getStorage();
  if (s) { try { s.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ } }
  emitChange();
}

// Whether a given embed kind should render at all, per the settings.
export function embedKindEnabled(
  s: EmbedSettings,
  kind: 'image' | 'video' | 'youtube' | 'spotify' | 'website' | 'file',
): boolean {
  if (!s.enabled) return false;
  if (kind === 'image') return s.images;
  if (kind === 'video') return s.videos;
  if (kind === 'youtube') return s.youtube;
  if (kind === 'spotify') return s.spotify;
  if (kind === 'website') return s.websites;
  return true; // 'file' download links are a safety affordance, always offered
}

const EVENT_NAME = 'boson:embeds:change';
function emitChange(): void {
  const w = globalThis as { dispatchEvent?: (e: Event) => boolean };
  if (typeof CustomEvent === 'undefined' || !w.dispatchEvent) return;
  try { w.dispatchEvent(new CustomEvent(EVENT_NAME)); } catch { /* best-effort */ }
}
export function onEmbedSettingsChange(fn: () => void): () => void {
  const w = globalThis as {
    addEventListener?: (t: string, l: EventListener) => void;
    removeEventListener?: (t: string, l: EventListener) => void;
  };
  if (!w.addEventListener || !w.removeEventListener) return () => {};
  const l = (): void => fn();
  w.addEventListener(EVENT_NAME, l);
  return () => w.removeEventListener?.(EVENT_NAME, l);
}

// Test seam.
export function __resetEmbedSettingsCache(): void { cached = null; }
